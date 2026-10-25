#!/usr/bin/env python3
"""
Lain's Telegram user account: a Telethon sidecar the telethon plugin talks to.

The Bot API (src/clients/telegram.ts) only sees chats the bot was added to.
A user account reads any public channel or group, searches the chats it is
in, looks up people and chats, and can write and join like a person. That is what
this process holds: the MTProto session, the api_id/api_hash, and a small JSON
API on 127.0.0.1 that only answers with the bearer token. The session never
leaves this process, and the model never sees it or the token.

    python telethon/lain_telethon.py login   # once, in a terminal: phone, code, 2FA
    python telethon/lain_telethon.py serve   # the API the plugin calls

Settings come from the environment, then the repo's .env:

    TELETHON_API_ID, TELETHON_API_HASH   from https://my.telegram.org
    LAINOS_TELETHON_TOKEN                shared with the plugin (openssl rand -hex 32)
    LAINOS_TELETHON_PORT                 default 8765
    LAINOS_TELETHON_SESSION              default data/telethon/lain.session
    LAINOS_TELETHON_PROXY                optional socks5://host:port or http://host:port
"""

from __future__ import annotations

import asyncio
import hmac
import os
import re
import sys
from collections import deque
from pathlib import Path
from urllib.parse import urlparse

from aiohttp import web
from telethon import TelegramClient, events, functions, types, utils
from telethon.errors import FloodWaitError, RPCError

ROOT = Path(__file__).resolve().parent.parent
MAX_LIMIT = 100
BUFFER = 1000
TEXT_CAP = 4000


def load_env() -> dict[str, str]:
    """The repo's .env under the process environment: a set variable wins."""
    values: dict[str, str] = {}
    env_file = ROOT / ".env"
    if env_file.is_file():
        for raw in env_file.read_text(encoding="utf8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                value = value[1:-1]
            else:
                value = value.split(" #", 1)[0].strip()
            values[key.strip()] = value
    values.update({k: v for k, v in os.environ.items() if v})
    return values


ENV = load_env()


def setting(key: str, default: str = "") -> str:
    return ENV.get(key, default).strip()


def session_path() -> Path:
    path = Path(setting("LAINOS_TELETHON_SESSION", "data/telethon/lain.session"))
    if not path.is_absolute():
        path = ROOT / path
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    return path


def proxy_config():
    raw = setting("LAINOS_TELETHON_PROXY")
    if not raw:
        return None
    url = urlparse(raw)
    if url.scheme not in ("socks5", "socks4", "http") or not url.hostname or not url.port:
        sys.exit("LAINOS_TELETHON_PROXY must look like socks5://host:port or http://host:port")
    return {
        "proxy_type": url.scheme,
        "addr": url.hostname,
        "port": url.port,
        **({"username": url.username, "password": url.password} if url.username else {}),
    }


def make_client() -> TelegramClient:
    api_id = setting("TELETHON_API_ID")
    api_hash = setting("TELETHON_API_HASH")
    if not api_id.isdigit() or not api_hash:
        sys.exit("Set TELETHON_API_ID and TELETHON_API_HASH (from https://my.telegram.org).")
    # Telethon appends ".session" itself.
    name = str(session_path()).removesuffix(".session")
    return TelegramClient(name, int(api_id), api_hash, proxy=proxy_config())


def lock_session() -> None:
    path = session_path()
    if path.exists():
        os.chmod(path, 0o600)


# --- targets and serialisation -------------------------------------------------

INVITE_RE = re.compile(r"(?:t\.me|telegram\.me)/(?:\+|joinchat/)([\w-]+)", re.I)
LINK_RE = re.compile(r"^(?:https?://)?(?:t\.me|telegram\.me)/(?:s/)?([A-Za-z0-9_]{4,})", re.I)


def invite_hash(target: str) -> str | None:
    match = INVITE_RE.search(target)
    return match.group(1) if match else None


def normalise(target: str) -> str | int:
    """@name, name, t.me/name, t.me/s/name or a numeric id → what get_entity takes."""
    target = str(target).strip()
    if re.fullmatch(r"-?\d+", target):
        return int(target)
    match = LINK_RE.match(target)
    if match:
        return match.group(1)
    return target.lstrip("@")


async def resolve(client: TelegramClient, target: str):
    if not str(target).strip():
        raise ValueError("no chat given")
    if invite_hash(str(target)):
        raise ValueError("that is an invite link — join it first with tg_join, then read it by its title or id")
    return await client.get_entity(normalise(target))


def title_of(entity) -> str:
    if entity is None:
        return ""
    if isinstance(entity, types.User):
        return utils.get_display_name(entity) or (entity.username or str(entity.id))
    return getattr(entity, "title", "") or str(getattr(entity, "id", ""))


def kind_of(entity) -> str:
    if isinstance(entity, types.User):
        return "bot" if entity.bot else "user"
    if isinstance(entity, types.Channel):
        return "channel" if entity.broadcast else "group"
    return "group"


def brief(entity) -> dict:
    return {
        "id": utils.get_peer_id(entity),
        "type": kind_of(entity),
        "title": title_of(entity),
        "username": getattr(entity, "username", None),
    }


def message_link(chat, msg_id: int) -> str | None:
    username = getattr(chat, "username", None)
    if username:
        return f"https://t.me/{username}/{msg_id}"
    if isinstance(chat, types.Channel):
        return f"https://t.me/c/{chat.id}/{msg_id}"
    return None


def media_kind(msg) -> str | None:
    if not msg.media:
        return None
    return type(msg.media).__name__.removeprefix("MessageMedia").lower()


async def message_json(msg, chat=None) -> dict:
    chat = chat or await msg.get_chat()
    sender = msg.sender if msg.sender is not None else None
    if sender is None and msg.sender_id and not msg.post:
        try:
            sender = await msg.get_sender()
        except RPCError:
            sender = None
    text = msg.message or ""
    return {
        "id": msg.id,
        "chat_id": msg.chat_id,
        "chat": title_of(chat),
        "date": msg.date.isoformat() if msg.date else None,
        "sender_id": msg.sender_id,
        "sender": (
            f"@{sender.username}" if getattr(sender, "username", None) else title_of(sender)
        ) if sender is not None else None,
        "text": text[:TEXT_CAP] + ("…" if len(text) > TEXT_CAP else ""),
        "views": msg.views,
        "forwards": msg.forwards,
        "reply_to": msg.reply_to_msg_id,
        "media": media_kind(msg),
        "link": message_link(chat, msg.id),
    }


def clamp(value, default: int) -> int:
    try:
        return max(1, min(MAX_LIMIT, int(value)))
    except (TypeError, ValueError):
        return default


# --- the API -------------------------------------------------------------------


class Sidecar:
    def __init__(self, client: TelegramClient, token: str):
        self.client = client
        self.token = token
        self.feed: deque[dict] = deque(maxlen=BUFFER)
        self.seq = 0
        self.watched: dict[str, int] = {}  # target as the plugin names it → peer id
        self.watched_ids: set[int] = set()
        client.add_event_handler(self.on_message, events.NewMessage())

    async def on_message(self, event) -> None:
        if event.chat_id not in self.watched_ids:
            return
        try:
            item = await message_json(event.message, await event.get_chat())
        except Exception as err:  # never let one odd message kill the handler
            print(f"telethon: could not read a watched message: {err}", file=sys.stderr)
            return
        self.seq += 1
        self.feed.append({"seq": self.seq, **item})

    @web.middleware
    async def guard(self, request: web.Request, handler):
        given = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(given.encode(), self.token.encode()):
            return web.json_response({"ok": False, "error": "unauthorized"}, status=401)
        try:
            return await handler(request)
        except FloodWaitError as err:
            return web.json_response(
                {"ok": False, "error": f"Telegram asks to wait {err.seconds}s (flood wait)", "wait": err.seconds},
                status=429,
            )
        except (ValueError, RPCError) as err:
            return web.json_response({"ok": False, "error": str(err)}, status=400)

    async def body(self, request: web.Request) -> dict:
        try:
            data = await request.json()
        except Exception:
            raise ValueError("request body must be JSON")
        if not isinstance(data, dict):
            raise ValueError("request body must be a JSON object")
        return data

    async def health(self, _request):
        me = await self.client.get_me()
        return web.json_response({"ok": True, "me": brief(me), "watching": len(self.watched_ids)})

    async def read(self, request):
        data = await self.body(request)
        chat = await resolve(self.client, data.get("chat", ""))
        query = str(data.get("query") or "") or None
        kwargs = {"limit": clamp(data.get("limit"), 20), "search": query}
        if data.get("offset_id"):
            kwargs["offset_id"] = int(data["offset_id"])
        if data.get("min_id"):
            kwargs["min_id"] = int(data["min_id"])
        messages = [await message_json(m, chat) async for m in self.client.iter_messages(chat, **kwargs)]
        return web.json_response({"ok": True, "chat": brief(chat), "messages": messages})

    async def search(self, request):
        data = await self.body(request)
        query = str(data.get("query") or "").strip()
        if not query:
            raise ValueError("no query given")
        limit = clamp(data.get("limit"), 20)
        messages = [await message_json(m) async for m in self.client.iter_messages(None, search=query, limit=limit)]
        return web.json_response({"ok": True, "messages": messages})

    async def info(self, request):
        data = await self.body(request)
        target = str(data.get("target") or "")
        code = invite_hash(target)
        if code:
            invite = await self.client(functions.messages.CheckChatInviteRequest(code))
            chat = getattr(invite, "chat", None)
            return web.json_response({
                "ok": True,
                "invite": True,
                "joined": isinstance(invite, types.ChatInviteAlready),
                "title": getattr(invite, "title", None) or title_of(chat),
                "participants": getattr(invite, "participants_count", None),
                "about": getattr(invite, "about", None),
                **({"chat": brief(chat)} if chat else {}),
            })
        entity = await resolve(self.client, target)
        out = {"ok": True, **brief(entity)}
        if isinstance(entity, types.User):
            full = await self.client(functions.users.GetFullUserRequest(entity))
            out.update({
                "about": full.full_user.about,
                "premium": bool(entity.premium),
                "verified": bool(entity.verified),
                "scam": bool(entity.scam or entity.fake),
                "common_chats": full.full_user.common_chats_count,
            })
        elif isinstance(entity, types.Channel):
            full = await self.client(functions.channels.GetFullChannelRequest(entity))
            out.update({
                "about": full.full_chat.about,
                "participants": full.full_chat.participants_count,
                "online": getattr(full.full_chat, "online_count", None),
                "pinned_id": full.full_chat.pinned_msg_id,
                "linked_chat_id": full.full_chat.linked_chat_id,
                "verified": bool(entity.verified),
                "scam": bool(entity.scam or entity.fake),
                "joined": not entity.left,
                "created": entity.date.isoformat() if entity.date else None,
            })
            if full.full_chat.pinned_msg_id:
                pinned = await self.client.get_messages(entity, ids=full.full_chat.pinned_msg_id)
                if pinned:
                    out["pinned"] = await message_json(pinned, entity)
        else:
            full = await self.client(functions.messages.GetFullChatRequest(entity.id))
            out.update({"about": full.full_chat.about, "participants": getattr(entity, "participants_count", None)})
        return web.json_response(out)

    async def send(self, request):
        data = await self.body(request)
        text = str(data.get("text") or "").strip()
        if not text:
            raise ValueError("nothing to send")
        chat = await resolve(self.client, data.get("chat", ""))
        reply_to = int(data["reply_to"]) if data.get("reply_to") else None
        msg = await self.client.send_message(chat, text, reply_to=reply_to, link_preview=False)
        return web.json_response({"ok": True, "chat": brief(chat), "id": msg.id, "link": message_link(chat, msg.id)})

    async def join(self, request):
        data = await self.body(request)
        target = str(data.get("chat") or "")
        code = invite_hash(target)
        if code:
            result = await self.client(functions.messages.ImportChatInviteRequest(code))
            chat = result.chats[0] if result.chats else None
        else:
            chat = await resolve(self.client, target)
            if not isinstance(chat, types.Channel):
                raise ValueError("only channels and supergroups can be joined by name — use an invite link")
            await self.client(functions.channels.JoinChannelRequest(chat))
        return web.json_response({"ok": True, **({"chat": brief(chat)} if chat else {})})

    async def updates(self, request):
        """The plugin names the chats it watches on every poll, so a restarted sidecar catches up."""
        data = await self.body(request)
        wanted = [str(c) for c in data.get("chats") or [] if str(c).strip()]
        unresolved = []
        for target in wanted:
            if target in self.watched:
                continue
            try:
                self.watched[target] = utils.get_peer_id(await resolve(self.client, target))
            except (ValueError, RPCError) as err:
                unresolved.append({"chat": target, "error": str(err)})
        for target in list(self.watched):
            if target not in wanted:
                del self.watched[target]
        self.watched_ids = set(self.watched.values())

        after = int(data.get("after") or 0)
        # A cursor past our counter means we restarted: hand back what we have.
        if after > self.seq:
            after = 0
        messages = [m for m in self.feed if m["seq"] > after]
        return web.json_response({
            "ok": True,
            "seq": self.seq,
            "watching": {t: i for t, i in self.watched.items()},
            "unresolved": unresolved,
            "messages": messages,
        })

    def app(self) -> web.Application:
        app = web.Application(middlewares=[self.guard], client_max_size=256 * 1024)
        app.router.add_get("/health", self.health)
        for name in ("read", "search", "info", "send", "join", "updates"):
            app.router.add_post(f"/{name}", getattr(self, name))
        return app


async def serve() -> None:
    token = setting("LAINOS_TELETHON_TOKEN")
    if len(token) < 16:
        sys.exit("Set LAINOS_TELETHON_TOKEN (at least 16 characters; openssl rand -hex 32).")
    port = int(setting("LAINOS_TELETHON_PORT", "8765"))
    client = make_client()
    await client.connect()
    if not await client.is_user_authorized():
        sys.exit("Not logged in. Run `python telethon/lain_telethon.py login` in a terminal first.")
    lock_session()
    me = await client.get_me()
    sidecar = Sidecar(client, token)
    runner = web.AppRunner(sidecar.app(), access_log=None)
    await runner.setup()
    # Loopback only: the token guards the account, the bind keeps it off the network.
    await web.TCPSite(runner, "127.0.0.1", port).start()
    print(f"telethon sidecar: {title_of(me)} (id {me.id}) on 127.0.0.1:{port}", flush=True)
    try:
        await client.run_until_disconnected()
    finally:
        await runner.cleanup()


async def login() -> None:
    client = make_client()
    await client.start()  # asks for the phone, the code and the 2FA password on this terminal
    me = await client.get_me()
    lock_session()
    print(f"logged in as {title_of(me)} (id {me.id}); session at {session_path()}")
    await client.disconnect()


def main() -> None:
    command = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if command == "login":
        asyncio.run(login())
    elif command == "serve":
        asyncio.run(serve())
    else:
        sys.exit("usage: lain_telethon.py [login|serve]")


if __name__ == "__main__":
    main()
