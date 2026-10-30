# python examples/python/quickstart.py   (after: pip install commertize-agent)
from commertize_agent import CommertizeClient, generate_passport_key

c = CommertizeClient()

print("tools:", ", ".join(t["name"] for t in c.list_tools()))

board = c.work_board()
print(f"board: {len(board['tasks'])} task(s), payouts_enabled={board['payouts_enabled']}")

key = generate_passport_key()
print("new passport address:", key.address)
print("lookup:", c.passport_lookup(key.address))
