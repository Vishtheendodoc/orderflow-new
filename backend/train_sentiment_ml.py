#!/usr/bin/env python3
"""
CLI to train the sentiment ML ensemble.

Usage:
  python train_sentiment_ml.py [--index NIFTY]

Requires DHAN_TOKEN_OPTIONS and DHAN_CLIENT_ID in .env.
Uses EOD snapshots if available (60+ days), else Dhan rolling option for backfill.
"""

import asyncio
import argparse
import logging
import os

from dotenv import load_dotenv
load_dotenv()

from ml_sentiment import train_and_save

logging.basicConfig(level=logging.INFO)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--index", default="NIFTY", help="Index name (NIFTY, BANKNIFTY, etc.)")
    args = parser.parse_args()
    if not os.getenv("DHAN_TOKEN_OPTIONS") or not os.getenv("DHAN_CLIENT_ID"):
        print("Set DHAN_TOKEN_OPTIONS and DHAN_CLIENT_ID in .env")
        return 1
    ok = asyncio.run(train_and_save(args.index))
    return 0 if ok else 1


if __name__ == "__main__":
    exit(main())
