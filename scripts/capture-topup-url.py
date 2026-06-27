#!/usr/bin/env python3
"""
Drives @OpenClawBoxBot via Telegram to get the real crypto checkout URL.
Outputs the URL to stdout so the Playwright test can consume it.
All diagnostic output goes to stderr so it doesn't pollute the URL on stdout.

Usage:
  python3 scripts/capture-topup-url.py \\
    --session ~/.config/telegram/2/session.dat \\
    --bot @OpenClawBoxBot \\
    --api-id $TELEGRAM_API_ID \\
    --api-hash $TELEGRAM_API_HASH

Environment variable overrides (take precedence over defaults, flags override env):
  TELEGRAM_API_ID    (default: 1993898)
  TELEGRAM_API_HASH  (default: 59d1e009d7ecb0c0a7224af3f461bb2e)
  TELEGRAM_SESSION   (default: ~/.config/telethon/session.dat)
  TELEGRAM_BOT       (default: @OpenClawBoxBot)
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

try:
    from telethon import TelegramClient, events
    from telethon.tl.types import (
        KeyboardButtonWebView,
        KeyboardButtonSimpleWebView,
        KeyboardButtonCallback,
        ReplyInlineMarkup,
    )
except ImportError:
    print("ERROR: telethon not installed. Run: pip install telethon==1.40.0", file=sys.stderr)
    sys.exit(1)


_DEFAULT_API_ID = 1993898
_DEFAULT_API_HASH = "59d1e009d7ecb0c0a7224af3f461bb2e"
# Primary session used by the eval harness (whoisdzianis owner account).
# Profile ~/.config/telegram/2 (raccoonfriendly) is a secondary session.
_DEFAULT_SESSION = os.path.expanduser("~/.config/telethon/session.dat")
_DEFAULT_BOT = "@OpenClawBoxBot"


def _err(msg: str) -> None:
    print(f"[capture-topup-url] {msg}", file=sys.stderr)


def find_webapp_url(reply_markup: object) -> str | None:
    """Extract a WebApp/URL from a message's reply_markup. Returns None if not found."""
    if not reply_markup or not hasattr(reply_markup, "rows"):
        return None
    for row in reply_markup.rows:
        for btn in row.buttons:
            url = None
            if isinstance(btn, (KeyboardButtonWebView, KeyboardButtonSimpleWebView)):
                url = getattr(btn, "url", None)
            elif hasattr(btn, "url") and not isinstance(btn, KeyboardButtonCallback):
                # Catch any other button type that carries a URL but is not a callback
                url = btn.url
            if url and ("sig=" in url or "/pay?" in url):
                return url
    return None


def has_callback_data(reply_markup: object, data: bytes) -> bool:
    """Return True if markup contains an inline callback button with the given data bytes."""
    if not reply_markup or not hasattr(reply_markup, "rows"):
        return False
    for row in reply_markup.rows:
        for btn in row.buttons:
            if isinstance(btn, KeyboardButtonCallback) and btn.data == data:
                return True
    return False


async def poll_for_button(
    client: TelegramClient,
    entity: object,
    callback_data: bytes,
    since_id: int,
    timeout: int = 30,
) -> object | None:
    """Poll recent messages from entity until one has a callback button with callback_data.

    Only considers messages with ID >= since_id to avoid stale messages.
    Returns the matching message or None on timeout.
    """
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        msgs = await client.get_messages(entity, limit=10)
        for msg in msgs:
            if msg.id < since_id:
                continue
            if has_callback_data(msg.reply_markup, callback_data):
                return msg
        await asyncio.sleep(1)
    return None


async def run(args: argparse.Namespace) -> int:
    session = os.path.expanduser(args.session)
    client = TelegramClient(session, args.api_id, args.api_hash)

    await client.connect()
    if not await client.is_user_authorized():
        _err("Session not authorized. Run: python3 scripts/capture-topup-url.py --session ... login")
        return 1

    bot = await client.get_entity(args.bot)
    bot_id = bot.id
    _err(f"Connected. Bot entity id={bot_id}")

    # Event to signal WebApp URL received via new-message stream
    webapp_url_event: asyncio.Event = asyncio.Event()
    webapp_url: list[str | None] = [None]

    @client.on(events.NewMessage(from_users=[bot_id]))  # type: ignore[arg-type]
    async def on_new_message(event: events.NewMessage.Event) -> None:
        url = find_webapp_url(event.message.reply_markup)
        if url and event.message.id > topup_msg_id:
            _err(f"WebApp URL found in message {event.message.id}: {url}")
            webapp_url[0] = url
            webapp_url_event.set()

    # Step 1: Send /topup — capture message ID so we ignore stale messages
    sent = await client.send_message(bot, "/topup")
    topup_msg_id: int = sent.id  # type: ignore[union-attr]
    _err(f"Sent /topup (msg_id={topup_msg_id})")

    # Step 2: Wait for credit pack keyboard (new message from bot after /topup)
    _err("Waiting for credit pack keyboard...")
    credit_msg = await poll_for_button(
        client, bot, b"topup:small", since_id=topup_msg_id, timeout=30
    )
    if not credit_msg:
        _err("ERROR: No credit pack keyboard received within 30s")
        return 1
    _err(f"Got credit pack keyboard (msg_id={credit_msg.id})")

    # Step 3: Click $5 Credit Pack → callback topup:small
    # Bot will EDIT this message to show payment methods
    try:
        await credit_msg.click(data=b"topup:small")
        _err("Clicked topup:small (callback sent)")
    except Exception as exc:
        _err(f"ERROR: Failed to click topup:small: {exc}")
        return 1

    # Step 4: Wait for payment method keyboard
    # Bot edits the message in place; poll for the updated markup
    _err("Waiting for payment method keyboard (bot edits message)...")
    method_msg = await poll_for_button(
        client, bot, b"topup_crypto:small", since_id=topup_msg_id, timeout=30
    )
    if not method_msg:
        _err("ERROR: No payment method keyboard received within 30s")
        return 1
    _err(f"Got payment method keyboard (msg_id={method_msg.id})")

    # Step 5: Click Pay with Crypto → callback topup_crypto:small
    # Bot sends a NEW message with WebApp button; event handler captures URL
    try:
        await method_msg.click(data=b"topup_crypto:small")
        _err("Clicked topup_crypto:small (callback sent)")
    except Exception as exc:
        _err(f"ERROR: Failed to click topup_crypto:small: {exc}")
        return 1

    # Step 6: Wait for bot's WebApp URL message
    _err("Waiting for WebApp URL message...")
    try:
        await asyncio.wait_for(webapp_url_event.wait(), timeout=30)
    except asyncio.TimeoutError:
        # Fallback: poll manually in case event was missed
        _err("Event timeout — polling manually for WebApp URL...")
        msgs = await client.get_messages(bot, limit=10)
        for msg in msgs:
            if msg.id <= topup_msg_id:
                continue
            url = find_webapp_url(msg.reply_markup)
            if url:
                webapp_url[0] = url
                break

    await client.disconnect()

    if not webapp_url[0]:
        _err("ERROR: No WebApp URL found")
        return 1

    # Success — print URL to stdout only
    print(webapp_url[0])
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Drive @OpenClawBoxBot to capture the real crypto checkout URL",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--session",
        default=os.environ.get("TELEGRAM_SESSION", _DEFAULT_SESSION),
        help=f"Telethon session path (default: {_DEFAULT_SESSION})",
    )
    parser.add_argument(
        "--bot",
        default=os.environ.get("TELEGRAM_BOT", _DEFAULT_BOT),
        help=f"Bot username or numeric ID (default: {_DEFAULT_BOT})",
    )
    parser.add_argument(
        "--api-id",
        type=int,
        default=int(os.environ.get("TELEGRAM_API_ID", _DEFAULT_API_ID)),
        help=f"Telegram API ID (default: {_DEFAULT_API_ID})",
    )
    parser.add_argument(
        "--api-hash",
        default=os.environ.get("TELEGRAM_API_HASH", _DEFAULT_API_HASH),
        help="Telegram API hash",
    )
    args = parser.parse_args()

    session_file = os.path.expanduser(args.session) + ".session"
    if not Path(session_file).exists():
        _err(f"ERROR: Session file not found: {session_file}")
        _err("The session must already exist — run login once manually first.")
        sys.exit(1)

    rc = asyncio.run(run(args))
    sys.exit(rc)


if __name__ == "__main__":
    main()
