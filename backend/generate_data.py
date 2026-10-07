"""
FraudGraph synthetic data generator.

Produces a realistic-looking Nigerian banking transaction dataset with:
  - A population of normal accounts behaving normally
  - Several deliberately embedded fraud patterns:
      1. Fan-in rings       (many accounts -> one mule account)
      2. Cycles             (money moves through a loop and returns)
      3. Shared-device rings (many accounts operated from one device)
      4. Rapid pass-through (money arrives and leaves within minutes)

Every fraud entity is tagged in a separate ground-truth table so detection
accuracy can be measured (see `python -m app.evaluate`).

Run:  python generate_data.py          (writes ./data/*.csv)

Design notes (these matter for honest evaluation):
  * Fully deterministic: every ID comes from the seeded RNG (no uuid4), so the
    same seed always produces byte-identical CSVs. Numbers in the README can
    therefore be reproduced exactly.
  * No third-party dependencies (Faker is no longer needed).
  * Every device_id that appears in a transaction exists in devices.csv, so the
    data loads cleanly into databases that enforce foreign keys (PostgreSQL).
  * Normal accounts each own a unique "home device". A few family-style pairs
    share a device (2 accounts) - below the detector threshold on purpose, so
    they exercise it without triggering it.
  * Rapid pass-through chains: only the *intermediate* accounts are labelled
    as fraud. The first account has no inbound transfer and the last has no
    outbound one, so the rule can never fire on them and they are not counted
    as planted pass-through accounts. Hop times are strictly increasing.
"""

import csv
import ipaddress
import os
import random
from datetime import datetime, timedelta

SEED = 42
random.seed(SEED)

NIGERIAN_FIRST_NAMES = [
    "Chinedu", "Ngozi", "Adaeze", "Emeka", "Oluwaseun", "Folake", "Ibrahim",
    "Amina", "Kunle", "Yetunde", "Chidinma", "Uche", "Tunde", "Chiamaka",
    "Bola", "Segun", "Ifeoma", "Musa", "Halima", "Obinna", "Adaobi", "Femi",
    "Blessing", "Kelechi", "Aisha", "Suleiman", "Nkechi", "Damilola",
    "Olamide", "Chukwuemeka", "Grace", "Fatima", "Ejiro", "Precious",
    "Abdullahi", "Temitope", "Chioma", "Yusuf", "Ronke", "Emmanuel",
]
NIGERIAN_LAST_NAMES = [
    "Okafor", "Adeyemi", "Balogun", "Eze", "Abubakar", "Nwosu", "Okonkwo",
    "Adebayo", "Mohammed", "Chukwu", "Ibrahim", "Afolabi", "Nnamdi",
    "Bello", "Okoro", "Adewale", "Yusuf", "Oyelaran", "Danjuma", "Uzoma",
    "Olawale", "Abdullahi", "Nwachukwu", "Ogundipe", "Suleiman", "Ekeh",
]

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
N_NORMAL_ACCOUNTS = 400
N_NORMAL_TXNS = 3500
N_FAMILY_DEVICE_PAIRS = 10          # normal account pairs sharing one device (2 users, below threshold)
SECONDARY_DEVICE_RATE = 0.10        # share of normal txns sent from the account's second device

N_FANIN_RINGS = 3                   # many senders -> one receiver
FANIN_RING_SIZE = (8, 15)           # accounts feeding the mule

N_CYCLE_RINGS = 3
CYCLE_RING_SIZE = (4, 6)            # accounts in the loop

N_DEVICE_RINGS = 3
DEVICE_RING_SIZE = (5, 9)           # accounts sharing one device

N_PASSTHROUGH_CHAINS = 4
PASSTHROUGH_CHAIN_LEN = (4, 6)      # total accounts in the chain (incl. origin and destination)

NIGERIAN_CITIES = [
    "Lagos", "Abuja", "Port Harcourt", "Ibadan", "Kano", "Enugu",
    "Benin City", "Kaduna", "Owerri", "Uyo", "Abeokuta", "Jos",
]
CHANNELS = ["mobile_app", "ussd", "pos", "internet_banking", "agent_banking"]
START_DATE = datetime(2026, 8, 1)
END_DATE = datetime(2026, 9, 14)

HEX = "0123456789ABCDEF"

accounts: dict = {}
devices: dict = {}
transactions: list = []
ground_truth: list = []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def nigerian_name():
    return f"{random.choice(NIGERIAN_FIRST_NAMES)} {random.choice(NIGERIAN_LAST_NAMES)}"


def random_timestamp(start=START_DATE, end=END_DATE):
    delta = end - start
    seconds = random.randint(0, int(delta.total_seconds()))
    return start + timedelta(seconds=seconds)


def random_ip():
    return str(ipaddress.IPv4Address(random.randint(0, 2**32 - 1)))


def _hex(n):
    return "".join(random.choice(HEX) for _ in range(n))


def unique_id(prefix, n, taken):
    """Deterministic (seeded) unique ID."""
    while True:
        candidate = f"{prefix}{_hex(n)}"
        if candidate not in taken:
            return candidate


_txn_ids: set = set()


def txn_id():
    tid = unique_id("TXN", 12, _txn_ids)
    _txn_ids.add(tid)
    return tid


def make_account():
    acct_id = unique_id("ACC", 10, accounts)
    opened = START_DATE.date() - timedelta(days=random.randint(30, 5 * 365))
    acc = {
        "account_id": acct_id,
        "owner_name": nigerian_name(),
        "phone": "0" + str(random.randint(7000000000, 9099999999)),
        "id_number": str(random.randint(10000000000, 99999999999)),  # BVN-like, fictional
        "city": random.choice(NIGERIAN_CITIES),
        "account_type": random.choice(["savings", "current", "blaze_youth"]),
        "opened_date": opened.isoformat(),
    }
    accounts[acct_id] = acc
    return acc


def make_device():
    """Create AND register a device so every transaction device_id exists in devices.csv."""
    dev_id = unique_id("DEV", 8, devices)
    dev = {
        "device_id": dev_id,
        "device_type": random.choice(["android", "ios", "web", "pos_terminal"]),
    }
    devices[dev_id] = dev
    return dev


def add_txn(sender, receiver, amount, ts, channel, device_id, status="successful"):
    transactions.append({
        "txn_id": txn_id(),
        "sender_account": sender,
        "receiver_account": receiver,
        "amount": round(amount, 2),
        "timestamp": ts.isoformat(),
        "channel": channel,
        "device_id": device_id,
        "ip_address": random_ip(),
        "location": accounts[sender]["city"],
        "status": status,
    })


# ---------------------------------------------------------------------------
# 1. Normal population
# ---------------------------------------------------------------------------
def build_normal_population():
    normal_ids = [make_account()["account_id"] for _ in range(N_NORMAL_ACCOUNTS)]

    # every normal account owns one home device, plus a spare one for occasional use
    home = {a: make_device()["device_id"] for a in normal_ids}
    spare = {a: make_device()["device_id"] for a in normal_ids}

    # a few "family" pairs share one device (2 users - well below the detector threshold)
    paired = random.sample(normal_ids, N_FAMILY_DEVICE_PAIRS * 2)
    for i in range(N_FAMILY_DEVICE_PAIRS):
        a, b = paired[2 * i], paired[2 * i + 1]
        home[b] = home[a]

    for _ in range(N_NORMAL_TXNS):
        sender = random.choice(normal_ids)
        receiver = random.choice(normal_ids)
        if sender == receiver:
            continue
        amount = round(random.lognormvariate(9.5, 1.1), 2)  # skewed, mostly small amounts
        amount = max(500, min(amount, 2_000_000))
        dev = spare[sender] if random.random() < SECONDARY_DEVICE_RATE else home[sender]
        add_txn(sender, receiver, amount, random_timestamp(), random.choice(CHANNELS), dev)

    return normal_ids, home


# ---------------------------------------------------------------------------
# 2. Fan-in rings: many "victim/mule feeder" accounts -> one collector account
# ---------------------------------------------------------------------------
def build_fan_in_rings():
    for ring_num in range(N_FANIN_RINGS):
        ring_id = f"FANIN-{ring_num + 1}"
        collector = make_account()
        ground_truth.append({
            "entity_id": collector["account_id"], "entity_type": "account",
            "fraud_pattern": "fan_in_collector", "ring_id": ring_id,
        })

        feeder_ids = []
        for _ in range(random.randint(*FANIN_RING_SIZE)):
            f = make_account()
            feeder_ids.append(f["account_id"])
            ground_truth.append({
                "entity_id": f["account_id"], "entity_type": "account",
                "fraud_pattern": "fan_in_feeder", "ring_id": ring_id,
            })

        # burst within a few hours
        burst_day = random_timestamp(START_DATE, END_DATE - timedelta(days=1))
        total_in = 0.0
        for feeder in feeder_ids:
            ts = burst_day + timedelta(minutes=random.randint(0, 180))
            amt = round(random.uniform(30_000, 250_000), 2)
            total_in += amt
            add_txn(feeder, collector["account_id"], amt, ts,
                    random.choice(["mobile_app", "internet_banking"]),
                    make_device()["device_id"])  # feeders each look like different devices

        # collector cashes out shortly after the burst completes -> pass-through signal too
        cashout_ts = burst_day + timedelta(hours=3, minutes=random.randint(5, 40))
        cashout_target = make_account()
        add_txn(collector["account_id"], cashout_target["account_id"], total_in * 0.95,
                cashout_ts, "agent_banking", make_device()["device_id"])


# ---------------------------------------------------------------------------
# 3. Cycles: A -> B -> C -> ... -> A, money loops back
# ---------------------------------------------------------------------------
def build_cycles():
    for ring_num in range(N_CYCLE_RINGS):
        ring_id = f"CYCLE-{ring_num + 1}"
        size = random.randint(*CYCLE_RING_SIZE)
        ring_accounts = []
        for _ in range(size):
            a = make_account()
            ring_accounts.append(a["account_id"])
            ground_truth.append({
                "entity_id": a["account_id"], "entity_type": "account",
                "fraud_pattern": "cycle_member", "ring_id": ring_id,
            })

        start_ts = random_timestamp(START_DATE, END_DATE - timedelta(hours=6))
        current_amount = round(random.uniform(100_000, 800_000), 2)
        for i in range(size):
            sender = ring_accounts[i]
            receiver = ring_accounts[(i + 1) % size]  # wraps back to start
            ts = start_ts + timedelta(minutes=15 * i + random.randint(0, 5))
            current_amount = round(current_amount * random.uniform(0.9, 0.98), 2)  # small skim per hop
            add_txn(sender, receiver, current_amount, ts,
                    random.choice(["mobile_app", "internet_banking"]),
                    make_device()["device_id"])


# ---------------------------------------------------------------------------
# 4. Shared-device rings: many distinct accounts, one physical device
# ---------------------------------------------------------------------------
def build_device_rings(normal_ids):
    for ring_num in range(N_DEVICE_RINGS):
        ring_id = f"DEVICE-{ring_num + 1}"
        shared_device = make_device()

        ring_accounts = []
        for _ in range(random.randint(*DEVICE_RING_SIZE)):
            a = make_account()
            ring_accounts.append(a["account_id"])
            ground_truth.append({
                "entity_id": a["account_id"], "entity_type": "account",
                "fraud_pattern": "shared_device_member", "ring_id": ring_id,
            })
        ground_truth.append({
            "entity_id": shared_device["device_id"], "entity_type": "device",
            "fraud_pattern": "shared_device", "ring_id": ring_id,
        })

        # each account does a few ordinary-looking transactions, all via this one device
        for acc in ring_accounts:
            for _ in range(random.randint(2, 5)):
                add_txn(acc, random.choice(normal_ids), random.uniform(5_000, 150_000),
                        random_timestamp(), "mobile_app", shared_device["device_id"])


# ---------------------------------------------------------------------------
# 5. Rapid pass-through chains: money arrives and leaves within minutes
# ---------------------------------------------------------------------------
def build_passthrough_chains():
    for chain_num in range(N_PASSTHROUGH_CHAINS):
        ring_id = f"PASSTHROUGH-{chain_num + 1}"
        length = random.randint(*PASSTHROUGH_CHAIN_LEN)
        chain = []
        for idx in range(length):
            a = make_account()
            chain.append(a["account_id"])
            # Only intermediates both receive and send; endpoints cannot trigger the rule.
            if 0 < idx < length - 1:
                ground_truth.append({
                    "entity_id": a["account_id"], "entity_type": "account",
                    "fraud_pattern": "rapid_passthrough", "ring_id": ring_id,
                })

        ts = random_timestamp(START_DATE, END_DATE - timedelta(hours=2))
        amount = round(random.uniform(200_000, 1_500_000), 2)
        for i in range(length - 1):
            ts = ts + timedelta(minutes=random.randint(2, 12))   # strictly increasing hop times
            amount = round(amount * random.uniform(0.95, 0.99), 2)
            add_txn(chain[i], chain[i + 1], amount, ts,
                    random.choice(["mobile_app", "ussd"]), make_device()["device_id"])


# ---------------------------------------------------------------------------
# 6. Failed / pending / reversed transactions (not signal for the detectors)
# ---------------------------------------------------------------------------
def build_non_successful(normal_ids, home):
    for _ in range(150):
        sender = random.choice(normal_ids)
        receiver = random.choice(normal_ids)
        if sender == receiver:
            continue
        add_txn(sender, receiver, random.uniform(1_000, 300_000), random_timestamp(),
                random.choice(CHANNELS), home[sender],
                status=random.choice(["failed", "pending", "reversed"]))


# ---------------------------------------------------------------------------
# Write CSVs
# ---------------------------------------------------------------------------
def write_csv(name, rows, fieldnames):
    with open(os.path.join(OUT_DIR, name), "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    normal_ids, home = build_normal_population()
    build_fan_in_rings()
    build_cycles()
    build_device_rings(normal_ids)
    build_passthrough_chains()
    build_non_successful(normal_ids, home)

    # shuffle so the fraud rings aren't sitting in a suspicious block at the file's tail
    random.shuffle(transactions)

    # integrity checks - fail loudly rather than ship a dataset that breaks on Postgres
    missing_dev = {t["device_id"] for t in transactions} - set(devices)
    missing_acc = ({t["sender_account"] for t in transactions}
                   | {t["receiver_account"] for t in transactions}) - set(accounts)
    assert not missing_dev, f"{len(missing_dev)} device ids missing from devices.csv"
    assert not missing_acc, f"{len(missing_acc)} account ids missing from accounts.csv"

    write_csv("accounts.csv", accounts.values(),
              ["account_id", "owner_name", "phone", "id_number", "city", "account_type", "opened_date"])
    write_csv("devices.csv", devices.values(), ["device_id", "device_type"])
    write_csv("transactions.csv", transactions,
              ["txn_id", "sender_account", "receiver_account", "amount", "timestamp",
               "channel", "device_id", "ip_address", "location", "status"])
    write_csv("ground_truth.csv", ground_truth, ["entity_id", "entity_type", "fraud_pattern", "ring_id"])

    print(f"Accounts:      {len(accounts)}")
    print(f"Devices:       {len(devices)}")
    print(f"Transactions:  {len(transactions)}")
    print(f"Ground truth entities: {len(ground_truth)}")
    print(f"Fraud rings: {N_FANIN_RINGS} fan-in, {N_CYCLE_RINGS} cycle, "
          f"{N_DEVICE_RINGS} shared-device, {N_PASSTHROUGH_CHAINS} passthrough")


if __name__ == "__main__":
    main()
