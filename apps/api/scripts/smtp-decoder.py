#!/usr/bin/env python3
"""Decode a raw RFC 822 message from stdin into JSON. Independent of nodemailer."""
import json
import sys
from email import policy
from email.parser import BytesParser


def main() -> None:
    raw = sys.stdin.buffer.read()
    message = BytesParser(policy=policy.default).parsebytes(raw)
    body_part = message.get_body(preferencelist=("plain",))
    if body_part is None:
        body_part = message
    payload = body_part.get_payload(decode=True)
    if payload is None:
        body = ""
    else:
        charset = body_part.get_content_charset() or "utf-8"
        body = payload.decode(charset, "replace")
    headers = {}
    for key, value in message.items():
        headers.setdefault(key.lower(), []).append(str(value))
    print(
        json.dumps(
            {
                "from": str(message.get("From", "")),
                "to": str(message.get("To", "")),
                "subject": str(message.get("Subject", "")),
                "messageId": str(message.get("Message-ID", "")),
                "returnPath": str(message.get("Return-Path", "")),
                "contentType": message.get_content_type(),
                "body": body,
                "headers": headers,
            }
        )
    )


if __name__ == "__main__":
    main()
