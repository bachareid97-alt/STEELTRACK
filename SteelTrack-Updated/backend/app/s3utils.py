# S3 helper: supports AWS S3 and MinIO
import os
import boto3
from botocore.client import Config

S3_ENDPOINT = os.environ.get('S3_ENDPOINT')
AWS_ACCESS_KEY_ID = os.environ.get('AWS_ACCESS_KEY_ID')
AWS_SECRET_ACCESS_KEY = os.environ.get('AWS_SECRET_ACCESS_KEY')
S3_BUCKET = os.environ.get('S3_BUCKET')
MINIO_USE_PATH_STYLE = os.environ.get('MINIO_USE_PATH_STYLE', 'false').lower() in ('1','true','yes')

_s3 = None

def s3_client():
    global _s3
    if _s3:
        return _s3
    if not AWS_ACCESS_KEY_ID or not AWS_SECRET_ACCESS_KEY:
        return None
    kwargs = {
        'aws_access_key_id': AWS_ACCESS_KEY_ID,
        'aws_secret_access_key': AWS_SECRET_ACCESS_KEY,
        'config': Config(s3={'addressing_style': 'path'} if MINIO_USE_PATH_STYLE else {})
    }
    if S3_ENDPOINT:
        _s3 = boto3.client('s3', endpoint_url=S3_ENDPOINT, **kwargs)
    else:
        _s3 = boto3.client('s3', **kwargs)
    return _s3


def upload_fileobj(fileobj, key, content_type=None):
    client = s3_client()
    if client and S3_BUCKET:
        extra = {'ContentType': content_type} if content_type else {}
        client.upload_fileobj(fileobj, S3_BUCKET, key, ExtraArgs=extra)
        if S3_ENDPOINT:
            return f"{S3_ENDPOINT.rstrip('/')}/{S3_BUCKET}/{key}"
        else:
            return f"https://{S3_BUCKET}.s3.amazonaws.com/{key}"
    # fallback: save locally
    out_dir = os.path.join(os.getcwd(), 'data', 'uploads')
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, key)
    with open(path, 'wb') as f:
        fileobj.seek(0)
        f.write(fileobj.read())
    return f"/data/uploads/{key}"
