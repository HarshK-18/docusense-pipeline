"""DocuSense processor.

Triggered by S3 ObjectCreated events on uploads/{userId}/{docId}.{ext}.
Validates the file, runs Textract AnalyzeExpense and Comprehend PII detection,
scores the result and routes the document to AUTO_APPROVED, PENDING_REVIEW or REJECTED.
"""
import json
import logging
import os
import urllib.parse
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from botocore.exceptions import ClientError

logger = logging.getLogger()
logger.setLevel(logging.INFO)

s3 = boto3.client("s3")
textract = boto3.client("textract")
comprehend = boto3.client("comprehend")
sns = boto3.client("sns")
dynamodb = boto3.resource("dynamodb")

TABLE_NAME = os.environ["TABLE_NAME"]
AUDIT_TABLE = os.environ["AUDIT_TABLE"]
SNS_TOPIC_ARN = os.environ["SNS_TOPIC_ARN"]
THRESHOLD = float(os.environ.get("THRESHOLD", "80"))
MAX_BYTES = 5 * 1024 * 1024  # 5 MB

FIELDS = ["VENDOR_NAME", "INVOICE_RECEIPT_DATE", "TOTAL"]

MAGIC = {
    "pdf": [b"%PDF-"],
    "png": [b"\x89PNG\r\n\x1a\n"],
    "jpg": [b"\xff\xd8\xff"],
    "jpeg": [b"\xff\xd8\xff"],
}

SENSITIVE_PII = {
    "BANK_ACCOUNT_NUMBER", "BANK_ROUTING", "INTERNATIONAL_BANK_ACCOUNT_NUMBER",
    "SWIFT_CODE", "CREDIT_DEBIT_NUMBER", "CREDIT_DEBIT_CVV", "CREDIT_DEBIT_EXPIRY",
    "PIN", "SSN", "PASSWORD", "PASSPORT_NUMBER", "DRIVER_ID",
    "AWS_ACCESS_KEY", "AWS_SECRET_KEY",
}


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_key(key):
    """uploads/{userId}/{docId}.{ext} -> (userId, docId, ext) or None."""
    parts = key.split("/")
    if len(parts) != 3 or parts[0] != "uploads" or "." not in parts[2]:
        return None
    user_id = parts[1]
    doc_id, ext = parts[2].rsplit(".", 1)
    return user_id, doc_id, ext.lower()


def validate_file(bucket, key, ext):
    """Return None if the file is valid, otherwise a rejection reason."""
    head = s3.head_object(Bucket=bucket, Key=key)
    size = head["ContentLength"]
    if size == 0:
        return "file is empty"
    if size > MAX_BYTES:
        return "file larger than 5 MB"
    if ext not in MAGIC:
        return "unsupported file type"
    first = s3.get_object(Bucket=bucket, Key=key, Range="bytes=0-7")["Body"].read()
    if not any(first.startswith(sig) for sig in MAGIC[ext]):
        return "file content does not match its extension"
    return None


def to_dynamo(obj):
    """DynamoDB does not accept floats; convert them to Decimal."""
    if isinstance(obj, float):
        return Decimal(str(obj))
    if isinstance(obj, dict):
        return {k: to_dynamo(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [to_dynamo(v) for v in obj]
    return obj


def write_audit(doc_id, user_id, old_status, new_status, reason=None):
    item = {
        "docId": doc_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "userId": user_id,
        "fromStatus": old_status,
        "toStatus": new_status,
        "actor": "system",
    }
    if reason:
        item["reason"] = reason
    dynamodb.Table(AUDIT_TABLE).put_item(Item=item)


def set_status(user_id, doc_id, status, key, extra=None):
    """Conditional update: only works for a new item or one still UPLOADING/PROCESSING."""
    table = dynamodb.Table(TABLE_NAME)
    now = now_iso()
    names = {"#s": "status"}
    values = {
        ":s": status,
        ":now": now,
        ":k": key,
        ":up": "UPLOADING",
        ":pr": "PROCESSING",
    }
    sets = ["#s = :s", "createdAt = if_not_exists(createdAt, :now)", "updatedAt = :now", "s3Key = :k"]
    for i, (name, val) in enumerate((extra or {}).items()):
        names[f"#e{i}"] = name
        values[f":e{i}"] = val
        sets.append(f"#e{i} = :e{i}")
    try:
        resp = table.update_item(
            Key={"userId": user_id, "docId": doc_id},
            UpdateExpression="SET " + ", ".join(sets),
            ConditionExpression="attribute_not_exists(docId) OR #s IN (:up, :pr)",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
            ReturnValues="ALL_OLD",
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            logger.info("%s/%s already has a final status; not changed", user_id, doc_id)
            return False
        raise

    logger.info("Saved %s/%s as %s", user_id, doc_id, status)
    old_status = resp.get("Attributes", {}).get("status", "NONE")
    try:
        write_audit(doc_id, user_id, old_status, status, (extra or {}).get("reason"))
    except Exception:
        logger.exception("Audit write failed for %s/%s", user_id, doc_id)
    return True


def extract_fields(response):
    """Pick the first VENDOR_NAME, INVOICE_RECEIPT_DATE and TOTAL with confidence."""
    found = {}
    for doc in response.get("ExpenseDocuments", []):
        for field in doc.get("SummaryFields", []):
            ftype = field.get("Type", {}).get("Text")
            if ftype in FIELDS and ftype not in found:
                value = field.get("ValueDetection", {})
                found[ftype] = {
                    "value": value.get("Text"),
                    "confidence": round(value.get("Confidence", 0), 2),
                }
    for name in FIELDS:
        found.setdefault(name, {"value": None, "confidence": 0})
    return found


def score_fields(fields):
    """Lowest confidence among the three fields; a missing field counts as 0."""
    return min(fields.get(name, {}).get("confidence", 0) or 0 for name in FIELDS)


def route_for(score):
    return "AUTO_APPROVED" if score >= THRESHOLD else "PENDING_REVIEW"


def build_text(response):
    """Rebuild the page text from Textract LINE blocks (fallback: label/value pairs)."""
    lines = []
    for doc in response.get("ExpenseDocuments", []):
        for block in doc.get("Blocks", []):
            if block.get("BlockType") == "LINE" and block.get("Text"):
                lines.append(block["Text"])
        if not lines:
            for field in doc.get("SummaryFields", []):
                label = field.get("LabelDetection", {}).get("Text", "")
                value = field.get("ValueDetection", {}).get("Text", "")
                if label or value:
                    lines.append(f"{label} {value}".strip())
    return "\n".join(lines)


def mask_value(value):
    """Keep only the last 4 characters, e.g. ********9012."""
    if len(value) <= 4:
        return "*" * len(value)
    return "*" * (len(value) - 4) + value[-4:]


def detect_pii(text):
    """Return (sorted PII types, masked values of sensitive types). Raw values are never kept."""
    text = text[:30000]
    if not text.strip():
        return [], []
    result = comprehend.detect_pii_entities(Text=text, LanguageCode="en")
    types = set()
    masked = []
    for ent in result.get("Entities", []):
        etype = ent["Type"]
        types.add(etype)
        if etype in SENSITIVE_PII:
            raw = text[ent["BeginOffset"]:ent["EndOffset"]]
            masked.append({"type": etype, "value": mask_value(raw)})
    return sorted(types), masked


def notify_pending_review(doc_id):
    """Email the admin (docId and status only, no PII)."""
    try:
        sns.publish(
            TopicArn=SNS_TOPIC_ARN,
            Subject="DocuSense: document needs review",
            Message=json.dumps({"docId": doc_id, "status": "PENDING_REVIEW"}),
        )
        logger.info("Review notification sent for %s", doc_id)
    except Exception:
        logger.exception("Could not send review notification for %s", doc_id)


def lambda_handler(event, context):
    for record in event.get("Records", []):
        bucket = record["s3"]["bucket"]["name"]
        key = urllib.parse.unquote_plus(record["s3"]["object"]["key"])
        logger.info("Processing s3://%s/%s", bucket, key)

        parsed = parse_key(key)
        if not parsed:
            logger.warning("Unexpected key format, skipping: %s", key)
            continue
        user_id, doc_id, ext = parsed

        reason = validate_file(bucket, key, ext)
        if reason:
            logger.info("Rejected %s: %s", key, reason)
            set_status(user_id, doc_id, "REJECTED", key, {"reason": reason})
            continue

        try:
            response = textract.analyze_expense(
                Document={"S3Object": {"Bucket": bucket, "Name": key}}
            )
        except ClientError as e:
            if e.response["Error"]["Code"] == "UnsupportedDocumentException":
                logger.info("Rejected %s: single-page files only", key)
                set_status(user_id, doc_id, "REJECTED", key, {"reason": "single-page files only"})
                continue
            raise

        fields = extract_fields(response)
        score = score_fields(fields)
        route = route_for(score)
        pii_types, pii_masked = detect_pii(build_text(response))
        logger.info(json.dumps({
            "key": key, "fields": fields,
            "score": score, "threshold": THRESHOLD, "route": route,
            "piiTypes": pii_types,
        }))
        saved = set_status(user_id, doc_id, route, key, {
            "fields": to_dynamo(fields),
            "score": to_dynamo(score),
            "piiTypes": pii_types,
            "piiMasked": pii_masked,
        })
        if saved and route == "PENDING_REVIEW":
            notify_pending_review(doc_id)

    return {"statusCode": 200}
