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


async def purge_demo(if_present: bool = False) -> None:
    """Remove every trace of the synthetic demo data, then rebuild the IOC store from the real CTI only.

    Demo and real sightings of the same value are merged into one IOC row (sources, score, TLP, tags), so they
    cannot be separated after the fact: all ingested state (IOCs + flags, source cursors/row hashes, sync
    history) is cleared and a full reconcile re-reads the real stores. Rules, allowlist, users, settings and
    the audit log are kept; the sample rules stay as ordinary starter rules (no DEMO badge) and are audited.
    """
    import shutil
    from pathlib import Path

    from sqlalchemy import delete, update

    from anchorage.core.audit import audit
    from anchorage.models import Detection, Ioc, Rule, SourceCursor, SourceRowState, SyncRun
    from anchorage.sync.service import SyncService

    s = get_settings()
    demo_dir = Path(s.demo_cti_dir).resolve()
    cti_dir = Path(s.cti_data_dir).resolve()
    async with session_scope() as session:
        counts = {
            "iocs": await session.scalar(select(func.count()).select_from(Ioc)),
            "demo_iocs": await session.scalar(select(func.count()).select_from(Ioc).where(Ioc.is_demo.is_(True))),
            "simulated_detections": await session.scalar(
                select(func.count()).select_from(Detection).where(Detection.is_simulated.is_(True))),
            "sync_runs": await session.scalar(select(func.count()).select_from(SyncRun)),
        }
        demo_rules = (await session.execute(select(Rule.id, Rule.name).where(Rule.is_demo.is_(True)))).all()
        demo_sources = await session.scalar(select(func.count()).select_from(SourceCursor)
                                            .where(SourceCursor.source_key.like("demo:%")))
        if if_present and not (counts["demo_iocs"] or counts["simulated_detections"] or demo_rules
                               or demo_sources or demo_dir.exists()):
            print("purge-demo: no demo data present")
            return
        await session.execute(delete(Detection).where(Detection.is_simulated.is_(True)))
        await session.execute(delete(Ioc))  # ioc_flags cascade
        await session.execute(delete(SourceRowState))
        await session.execute(delete(SourceCursor))
        await session.execute(delete(SyncRun))
        await session.execute(update(Rule).where(Rule.is_demo.is_(True)).values(is_demo=False))
        for rid, name in demo_rules:
            await audit(session, None, "rule.update", "rule", rid, {"is_demo": True},
                        {"is_demo": False, "note": f"kept as starter rule after demo purge: {name}"})
        await audit(session, None, "data.purge_demo", "system", None, counts,
                    {"demo_rules_kept_as_starter_rules": len(demo_rules)})
    print(f"purge-demo: cleared {counts}; {len(demo_rules)} sample rule(s) kept as starter rules")

    if demo_dir.exists() and cti_dir not in (demo_dir, *demo_dir.parents) and demo_dir != cti_dir:
        shutil.rmtree(demo_dir)  # our own generated fixture, never inside the CTI folder
        print(f"purge-demo: removed demo fixture {demo_dir}")

    run = await SyncService().run("daily", triggered_by="purge-demo")
    print(f"purge-demo: full reconcile from the real CTI -> {run.status}: {run.new_count} IOCs, "
          f"{run.rejected_count} rejected, {run.flagged_count} flagged")


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
    sd.add_argument("--if-empty", action="store_true", help="only seed when the database has no IOCs")
    sy = sub.add_parser("sync")
    sy.add_argument("--kind", choices=["manual", "hourly", "daily"], default="manual")
    sy.add_argument("--inline", action="store_true", help="run in this process instead of queueing")
    sub.add_parser("reevaluate")
    pd = sub.add_parser("purge-demo", help="delete all demo data and re-sync from the real CTI only")
    pd.add_argument("--if-present", action="store_true", help="do nothing when no demo data is present")
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
                from anchorage.models import Ioc

                if args.if_empty:
                    async with session_scope() as s:
                        if await s.scalar(select(func.count()).select_from(Ioc)):
                            print("seed-demo: database already has IOCs, skipping")
                            return
                await seed_demo(count=args.count, sync=not args.no_sync)
            elif args.cmd == "sync":
                from anchorage.sync.service import queue_or_run

                print(await queue_or_run(args.kind, inline=args.inline, triggered_by="cli"))
            elif args.cmd == "purge-demo":
                await purge_demo(if_present=args.if_present)
            elif args.cmd == "reevaluate":
                from anchorage.rules.engine import RuleEngine

                async with session_scope() as session:
                    print(await RuleEngine(session).evaluate_all())
        finally:
            await dispose_engine()

    asyncio.run(run())


if __name__ == "__main__":
    main()
