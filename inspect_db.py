import sqlite3
import json

DB_PATH = r'D:\Users\Seahi\.local\share\mimocode\mimocode.db'
PROJECT_ID = '6956aa09-e94c-4479-a9c1-a491883aef07'

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
c = conn.cursor()

# Get ALL user messages from the most recent active session (ses_0af8d55)
print("=== ALL user messages from ses_0af8d55 (Snap Layouts session) ===")
c.execute("""
    SELECT json_extract(p.data, '$.text') as text, m.time_created
    FROM part p
    JOIN message m ON p.message_id = m.id
    WHERE m.session_id = 'ses_0af8d55fdffeiFycJsuJFoS66j'
      AND json_extract(m.data, '$.role') = 'user'
      AND json_extract(p.data, '$.type') = 'text'
    ORDER BY m.time_created ASC
""", ())
for row in c.fetchall():
    text = (row['text'] or '')[:500]
    # Skip system-reminder and checkpoint-writer messages
    if text.startswith('<system-reminder>') or 'checkpoint-writer' in text:
        continue
    print(f"\n  ts={row['time_created']}")
    print(f"  {text[:400]}")

# Get all user messages from ses_0ba166576ffe (data refresh bug session)
print("\n\n=== ALL user messages from ses_0ba166576ffe (data refresh bug) ===")
c.execute("""
    SELECT json_extract(p.data, '$.text') as text, m.time_created
    FROM part p
    JOIN message m ON p.message_id = m.id
    WHERE m.session_id = 'ses_0ba166576ffe9GCnCk6mrJsTik'
      AND json_extract(m.data, '$.role') = 'user'
      AND json_extract(p.data, '$.type') = 'text'
    ORDER BY m.time_created ASC
""", ())
for row in c.fetchall():
    text = (row['text'] or '')[:500]
    if text.startswith('<system-reminder>') or 'checkpoint-writer' in text:
        continue
    print(f"\n  ts={row['time_created']}")
    print(f"  {text[:400]}")

# Get all user messages from ses_0c96a8747ffe (custom title bar)
print("\n\n=== ALL user messages from ses_0c96a8747ffe (custom title bar) ===")
c.execute("""
    SELECT json_extract(p.data, '$.text') as text, m.time_created
    FROM part p
    JOIN message m ON p.message_id = m.id
    WHERE m.session_id = 'ses_0c96a8747ffe3BgDtfuAyfH6Nb'
      AND json_extract(m.data, '$.role') = 'user'
      AND json_extract(p.data, '$.type') = 'text'
    ORDER BY m.time_created ASC
""", ())
for row in c.fetchall():
    text = (row['text'] or '')[:500]
    if text.startswith('<system-reminder>') or 'checkpoint-writer' in text:
        continue
    print(f"\n  ts={row['time_created']}")
    print(f"  {text[:400]}")

# Get all user messages from ses_0c4402983ffe (workflow session)
print("\n\n=== ALL user messages from ses_0c4402983ffe (workflow) ===")
c.execute("""
    SELECT json_extract(p.data, '$.text') as text, m.time_created
    FROM part p
    JOIN message m ON p.message_id = m.id
    WHERE m.session_id = 'ses_0c4402983ffeDne9CRrgBw2mqv'
      AND json_extract(m.data, '$.role') = 'user'
      AND json_extract(p.data, '$.type') = 'text'
    ORDER BY m.time_created ASC
""", ())
for row in c.fetchall():
    text = (row['text'] or '')[:500]
    if text.startswith('<system-reminder>') or 'checkpoint-writer' in text:
        continue
    print(f"\n  ts={row['time_created']}")
    print(f"  {text[:400]}")

conn.close()
