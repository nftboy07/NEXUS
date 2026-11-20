import httpx
import hashlib
import hmac
import json

from channels.telegram import TelegramChannel
from channels.discord import DiscordChannel
from channels.webhook import WebhookChannel, sign


class SpyTransport(httpx.BaseTransport):
    def __init__(self):
        self.requests = []

    def handle_request(self, request):
        body = request.read()
        self.requests.append((str(request.url), dict(request.headers), body))
        return httpx.Response(200, json={"ok": True})


def test_telegram_sends_formatted_message(record, store, log):
    t = SpyTransport()
    ch = TelegramChannel(log, token="tok", chat_id="cid", transport=t)
    assert ch.send("the message", record) == "sent"
    url, _, body = t.requests[0]
    assert url == "https://api.telegram.org/bottok/sendMessage"
    assert json.loads(body)["text"] == "the message"


def test_discord_posts_content(record, store, log):
    t = SpyTransport()
    ch = DiscordChannel(log, webhook_url="https://discord.example/wh", transport=t)
    assert ch.send("hello", record) == "sent"
    assert t.requests[0][0] == "https://discord.example/wh"


def test_webhook_hmac_signature(record, store, log):
    t = SpyTransport()
    ch = WebhookChannel(log, urls="https://h.example/1, https://h.example/2",
                        secret="s3cret", transport=t)
    assert ch.send("m", record) == "sent"
    assert len(t.requests) == 2
    url, headers, body = t.requests[0]
    expected = "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
    assert headers["x-nexus-signature"] == expected


def test_webhook_unsigned_never_sent(record, store, log):
    t = SpyTransport()
    ch = WebhookChannel(log, urls="https://h.example/1", secret=None, transport=t)
    import os
    os.environ.pop("WEBHOOK_SECRET", None)
    assert ch.send("m", record) == "skipped_no_config"
    assert not t.requests
