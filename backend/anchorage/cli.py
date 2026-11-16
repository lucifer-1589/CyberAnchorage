"""Operational CLI: python -m anchorage.cli <command>."""

from __future__ import annotations

import argparse
import asyncio
import getpass
import logging
import sys

from sqlalchemy import func, select

from anchorage.core.config import get_settings
from anchorage.core.db import dispose_engine, init_engine, session_scope
from anchorage.core.security import MIN_PASSWORD_LENGTH, hash_password
from anchorage.models import User

log = logging.getLogger("anchorage.cli")


async def bootstrap() -> None:
    """Create the first admin from ADMIN_EMAIL/ADMIN_PASSWORD when the users table is empty."""
    s = get_settings()
    async with session_scope() as session:
        count = await session.scalar(select(func.count()).select_from(User))
        if count:
            print("bootstrap: users exist, nothing to do")
            return
        if len(s.admin_password) < MIN_PASSWORD_LENGTH:
            print(
                f"bootstrap: no users and ADMIN_PASSWORD unset/short (<{MIN_PASSWORD_LENGTH}); "
                "run `python -m anchorage.cli create-admin` to create one"
            )
            return
        session.add(
            User(email=s.admin_email.lower(), name="Administrator", role="admin",
                 password_hash=hash_password(s.admin_password))
        )
        print(f"bootstrap: created admin {s.admin_email}")


async def create_admin(email: str, password: str | None) -> None:
    password = password or getpass.getpass("Password: ")
    if len(password) < MIN_PASSWORD_LENGTH:
        sys.exit(f"password must be at least {MIN_PASSWORD_LENGTH} characters")
    async with session_scope() as session:
        user = (await session.execute(select(User).where(User.email == email.lower()))).scalar_one_or_none()
        if user:
            user.password_hash = hash_password(password)
            user.role = "admin"
            user.is_active = True
        else:
            session.add(User(email=email.lower(), name="Administrator", role="admin",
                             password_hash=hash_password(password)))
    print(f"admin {email} ready")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="anchorage")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("bootstrap")
    ca = sub.add_parser("create-admin")
    ca.add_argument("--email", required=True)
    ca.add_argument("--password")
    sd = sub.add_parser("seed-demo")
    sd.add_argument("--count", type=int, default=1500)
    sd.add_argument("--no-sync", action="store_true")
    sy = sub.add_parser("sync")
    sy.add_argument("--kind", choices=["manual", "hourly", "daily"], default="manual")
    sy.add_argument("--inline", action="store_true", help="run in this process instead of queueing")
    sub.add_parser("reevaluate")
    args = parser.parse_args(argv)

    async def run() -> None:
        init_engine()
        try:
            if args.cmd == "bootstrap":
                await bootstrap()
            elif args.cmd == "create-admin":
                await create_admin(args.email, args.password)
            elif args.cmd == "seed-demo":
                from anchorage.demo.seed import seed_demo

                await seed_demo(count=args.count, sync=not args.no_sync)
            elif args.cmd == "sync":
                from anchorage.sync.service import queue_or_run

                print(await queue_or_run(args.kind, inline=args.inline, triggered_by="cli"))
            elif args.cmd == "reevaluate":
                from anchorage.rules.engine import RuleEngine

                async with session_scope() as session:
                    print(await RuleEngine(session).evaluate_all())
        finally:
            await dispose_engine()

    asyncio.run(run())


if __name__ == "__main__":
    main()
