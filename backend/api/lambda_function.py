"""DocuSense API.

Routes (HTTP API payload 2.0, JWT authorizer in front):
  GET  /documents          the caller's own documents
  GET  /documents/{id}     one of the caller's documents, with a 5-minute view link
  GET  /review/pending     documents waiting for review (reviewers group only)
  POST /review/{id}        approve, correct or reject a pending document (reviewers only)
The caller's id always comes from the verified token (sub), never from the request.
"""
import json
import os
import re
from datetime import datetime, timezone
from decimal import Decimal

import boto3
from boto3.dynamodb.conditions import Attr, Key
from botocore.config import Config
from botocore.exceptions import ClientError

TABLE_NAME = os.environ["TABLE_NAME"]
AUDIT_TABLE = os.environ["AUDIT_TABLE"]
REGION = os.environ["AWS_REGION"]
BUCKET = os.environ["BUCKET_NAME"]

dynamodb = boto3.resource("dynamodb")
table = dynamodb.Table(TABLE_NAME)
audit_table = dynamodb.Table(AUDIT_TABLE)

s3 = boto3.client(
    "s3",
    region_name=REGION,
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(signature_version="s3v4"),
)

DOC_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
HIDDEN_FIELDS = {"s3Key"}  # internal, never returned to the browser
SUMMARY_FIELDS = ["docId", "filename", "status", "createdAt", "updatedAt", "score", "reason"]
REVIEW_GROUP = "reviewers"
PENDING_FIELDS = ["userId", "docId", "filename", "contentType", "status", "createdAt",
                  "updatedAt", "score", "reason", "fields", "piiTypes"]
VIEW_EXPIRES = 300  # 5 minutes
ALLOWED_FIELDS = {"VENDOR_NAME", "INVOICE_RECEIPT_DATE", "TOTAL"}
ACTIONS = {"approve": "APPROVED", "correct": "CORRECTED", "reject": "REJECTED"}


def _json_default(o):
    if isinstance(o, Decimal):
        return int(o) if o == o.to_integral_value() else float(o)
    raise TypeError(f"Not serializable: {type(o)}")


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body, default=_json_default),
    }


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def clean(item):
    return {k: v for k, v in item.items() if k not in HIDDEN_FIELDS}


def summary(item):
    return {k: item[k] for k in SUMMARY_FIELDS if k in item}


def view_url(item):
    """5-minute link to open the stored file in the browser."""
    key = item.get("s3Key")
    if not key or item.get("status") == "UPLOADING":
        return None
    return s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": BUCKET, "Key": key, "ResponseContentDisposition": "inline"},
        ExpiresIn=VIEW_EXPIRES,
    )


def list_documents(user_id):
    resp = table.query(KeyConditionExpression=Key("userId").eq(user_id), Limit=100)
    items = [summary(i) for i in resp.get("Items", [])]
    items.sort(key=lambda i: i.get("createdAt", ""), reverse=True)
    return respond(200, {"documents": items})


def get_document(user_id, doc_id):
    if not doc_id or not DOC_ID_RE.match(doc_id):
        return respond(400, {"error": "invalid document id"})
    resp = table.get_item(Key={"userId": user_id, "docId": doc_id})
    item = resp.get("Item")
    if not item:
        return respond(404, {"error": "document not found"})
    result = clean(item)
    url = view_url(item)
    if url:
        result["viewUrl"] = url
        result["viewUrlExpiresIn"] = VIEW_EXPIRES
    return respond(200, result)


def get_groups(claims):
    """cognito:groups can arrive as a list, '[reviewers]' or '["reviewers"]'."""
    raw = claims.get("cognito:groups")
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(g) for g in raw]
    text = str(raw).strip()
    if text.startswith("[") and text.endswith("]"):
        text = text[1:-1]
    return [g.strip("\"'") for g in re.split(r"[\s,]+", text) if g.strip("\"'")]


def is_reviewer(claims):
    return REVIEW_GROUP in get_groups(claims)


def list_pending():
    resp = table.query(
        IndexName="status-createdAt",
        KeyConditionExpression=Key("status").eq("PENDING_REVIEW"),
        Limit=50,
    )
    items = []
    for i in resp.get("Items", []):
        entry = {k: i[k] for k in PENDING_FIELDS if k in i}
        url = view_url(i)
        if url:
            entry["viewUrl"] = url
        items.append(entry)
    return respond(200, {"documents": items})


def find_pending(doc_id):
    """Find a PENDING_REVIEW document by docId through the status index."""
    kwargs = {
        "IndexName": "status-createdAt",
        "KeyConditionExpression": Key("status").eq("PENDING_REVIEW"),
        "FilterExpression": Attr("docId").eq(doc_id),
    }
    while True:
        resp = table.query(**kwargs)
        items = resp.get("Items", [])
        if items:
            return items[0]
        last = resp.get("LastEvaluatedKey")
        if not last:
            return None
        kwargs["ExclusiveStartKey"] = last


def write_audit(doc_id, owner_id, new_status, reviewer, action, corrected, reason):
    entry = {
        "docId": doc_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "userId": owner_id,
        "fromStatus": "PENDING_REVIEW",
        "toStatus": new_status,
        "actor": reviewer,
        "action": action,
    }
    if corrected:
        entry["correctedFields"] = sorted(corrected)
    if reason:
        entry["reason"] = reason
    audit_table.put_item(Item=entry)


def review_document(reviewer, doc_id, event):
    if not doc_id or not DOC_ID_RE.match(doc_id):
        return respond(400, {"error": "invalid document id"})
    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return respond(400, {"error": "body must be valid JSON"})
    if not isinstance(body, dict):
        return respond(400, {"error": "body must be a JSON object"})

    action = body.get("action")
    new_status = ACTIONS.get(action)
    if not new_status:
        return respond(400, {"error": "action must be approve, correct or reject"})

    corrections = {}
    if action == "correct":
        raw = body.get("fields")
        if not isinstance(raw, dict) or not raw:
            return respond(400, {"error": "correct needs a non-empty fields object"})
        for name, value in raw.items():
            if (name not in ALLOWED_FIELDS or not isinstance(value, str)
                    or not value.strip() or len(value) > 200):
                return respond(400, {"error": f"invalid correction for {name}"})
            corrections[name] = value.strip()

    reason = None
    if action == "reject":
        reason = body.get("reason", "rejected by reviewer")
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 200:
            return respond(400, {"error": "reason must be 1 to 200 characters"})
        reason = reason.strip()

    item = find_pending(doc_id)
    if not item:
        return respond(404, {"error": "no pending document with this id"})

    now = now_iso()
    names = {"#s": "status"}
    values = {":s": new_status, ":pending": "PENDING_REVIEW", ":rb": reviewer, ":ra": now}
    sets = ["#s = :s", "reviewedBy = :rb", "reviewedAt = :ra", "updatedAt = :ra"]

    if corrections:
        merged = dict(item.get("fields", {}))
        for name, val in corrections.items():
            entry = dict(merged.get(name, {"value": None, "confidence": 0}))
            entry["value"] = val
            entry["corrected"] = True
            merged[name] = entry
        names["#f"] = "fields"
        values[":f"] = merged
        sets.append("#f = :f")
    if reason:
        names["#r"] = "reason"
        values[":r"] = reason
        sets.append("#r = :r")

    try:
        table.update_item(
            Key={"userId": item["userId"], "docId": doc_id},
            UpdateExpression="SET " + ", ".join(sets),
            ConditionExpression="#s = :pending",
            ExpressionAttributeNames=names,
            ExpressionAttributeValues=values,
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return respond(409, {"error": "document is no longer pending review"})
        raise

    try:
        write_audit(doc_id, item["userId"], new_status, reviewer, action,
                    list(corrections), reason)
    except Exception:
        print("Audit write failed for", doc_id)

    return respond(200, {
        "docId": doc_id,
        "status": new_status,
        "reviewedBy": reviewer,
        "reviewedAt": now,
    })


def lambda_handler(event, context):
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )
    user_id = claims.get("sub")
    if not user_id:
        return respond(401, {"error": "unauthorized"})

    route = event.get("routeKey")
    params = event.get("pathParameters") or {}

    if route == "GET /documents":
        return list_documents(user_id)
    if route == "GET /documents/{id}":
        return get_document(user_id, params.get("id"))
    if route == "GET /review/pending":
        if not is_reviewer(claims):
            return respond(403, {"error": "reviewers only"})
        return list_pending()
    if route == "POST /review/{id}":
        if not is_reviewer(claims):
            return respond(403, {"error": "reviewers only"})
        return review_document(user_id, params.get("id"), event)

    return respond(404, {"error": "route not found"})
