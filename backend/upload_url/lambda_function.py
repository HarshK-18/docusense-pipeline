"""DocuSense upload-url.

Called through API Gateway (JWT authorizer). Returns a short-lived presigned POST
that lets the browser upload one file to uploads/{sub}/{uuid}.{ext}, and creates
the UPLOADING record in the Documents table.
"""
import json
import os
import re
import uuid
from datetime import datetime, timezone

import boto3
from botocore.config import Config

REGION = os.environ["AWS_REGION"]
BUCKET = os.environ["BUCKET_NAME"]
TABLE_NAME = os.environ["TABLE_NAME"]

MAX_BYTES = 5 * 1024 * 1024  # 5 MB
EXPIRES_IN = 300             # presigned POST valid for 5 minutes
EXT_BY_TYPE = {
    "application/pdf": "pdf",
    "image/png": "png",
    "image/jpeg": "jpg",
}

s3 = boto3.client(
    "s3",
    region_name=REGION,
    endpoint_url=f"https://s3.{REGION}.amazonaws.com",
    config=Config(signature_version="s3v4"),
)
table = boto3.resource("dynamodb").Table(TABLE_NAME)


def respond(status, body):
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }


def clean_filename(value):
    """Keep only a short, printable file name (no folders)."""
    if not isinstance(value, str):
        return "document"
    name = re.split(r"[\\/]", value)[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()
    return name[:100] or "document"


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

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return respond(400, {"error": "body must be valid JSON"})

    content_type = body.get("contentType") if isinstance(body, dict) else None
    ext = EXT_BY_TYPE.get(content_type)
    if not ext:
        return respond(400, {"error": "contentType must be application/pdf, image/png or image/jpeg"})

    filename = clean_filename(body.get("filename"))

    doc_id = uuid.uuid4().hex
    key = f"uploads/{user_id}/{doc_id}.{ext}"

    post = s3.generate_presigned_post(
        Bucket=BUCKET,
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[
            {"Content-Type": content_type},
            ["content-length-range", 1, MAX_BYTES],
        ],
        ExpiresIn=EXPIRES_IN,
    )

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    table.put_item(
        Item={
            "userId": user_id,
            "docId": doc_id,
            "status": "UPLOADING",
            "createdAt": now,
            "updatedAt": now,
            "s3Key": key,
            "contentType": content_type,
            "filename": filename,
        },
        ConditionExpression="attribute_not_exists(docId)",
    )

    return respond(200, {
        "url": post["url"],
        "fields": post["fields"],
        "docId": doc_id,
        "key": key,
        "maxBytes": MAX_BYTES,
        "expiresIn": EXPIRES_IN,
    })
