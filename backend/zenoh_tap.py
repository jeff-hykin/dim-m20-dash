# The recorder's zenoh tap: subscribes to the topics a recording asked for and hands every sample to M20 Ctrl's backend
# (recording.ts) on stdout, rate-capped per topic. Run with DIMOS_APP's dimosPython (the dimos install's venv, which has
# eclipse-zenoh) and DIMOS_APP's zenohConnect; it only subscribes: it never publishes or queries anything.
#   argv[1]: JSON {"connect": "tcp/...:7447", "topics": [{"key": "dimos/tf/tf2_msgs.TFMessage", "maxHz": null}, ...]}
#   stdout: frames, little endian
#     1 | u16 key length | key | u64 receive time (ns since epoch) | u32 payload length | payload   (a sample)
#     2 | u32 length | JSON {"<key>": {"received", "skipped" (over its rate cap), "dropped" (backed up)}}   (each second)
# A sample that arrives while MAX_QUEUED_BYTES are waiting to be written is dropped (counted), so a slow disk can't
# stall zenoh or grow without bound. Exits when stdin closes (the backend went away) or on SIGTERM.
import json
import queue
import struct
import sys
import threading
import time

import zenoh

MAX_QUEUED_BYTES = 64 * 1024 * 1024


def main():
    request = json.loads(sys.argv[1])
    config = zenoh.Config()
    config.insert_json5("mode", json.dumps("client"))
    config.insert_json5("connect/endpoints", json.dumps([request["connect"]]))
    session = zenoh.open(config)
    out = sys.stdout.buffer
    pending = queue.Queue()
    queued = [0]
    lock = threading.Lock()
    stats = {}
    last = {}

    def subscriber(key, max_hz):
        period = 1.0 / max_hz if max_hz else 0.0
        counts = stats.setdefault(key, {"received": 0, "skipped": 0, "dropped": 0})

        def on_sample(sample):
            now = time.time()
            counts["received"] += 1
            if period and now - last.get(key, 0.0) < period:
                counts["skipped"] += 1
                return
            payload = sample.payload.to_bytes()
            with lock:
                if queued[0] + len(payload) > MAX_QUEUED_BYTES:
                    counts["dropped"] += 1
                    return
                queued[0] += len(payload)
            last[key] = now
            name = str(sample.key_expr).encode()
            # counted against MAX_QUEUED_BYTES until the writer loop below has written it
            pending.put(struct.pack("<BH", 1, len(name)) + name + struct.pack("<QI", int(now * 1e9), len(payload)) + payload)

        return session.declare_subscriber(key, on_sample)

    subscribers = [subscriber(topic["key"], topic.get("maxHz")) for topic in request["topics"]]

    def report():
        while True:
            time.sleep(1.0)
            body = json.dumps(stats).encode()
            pending.put(struct.pack("<BI", 2, len(body)) + body)

    def watch_stdin():
        sys.stdin.read()  # the backend closed our stdin (or went away): stop
        pending.put(None)

    threading.Thread(target=report, daemon=True).start()
    threading.Thread(target=watch_stdin, daemon=True).start()
    try:
        while True:
            frame = pending.get()
            if frame is None:
                break
            out.write(frame)
            out.flush()
            if frame[0] == 1:
                with lock:
                    queued[0] -= struct.unpack_from("<I", frame, 3 + struct.unpack_from("<H", frame, 1)[0] + 8)[0]
    except BrokenPipeError:
        pass
    finally:
        for sub in subscribers:
            sub.undeclare()
        session.close()


if __name__ == "__main__":
    main()
