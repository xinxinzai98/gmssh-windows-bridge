"""Transparent SSH channel relay; no local command evaluation or path rewriting."""
import socket
import threading
import time


def relay(downstream, upstream, timeout):
    """Preserve stdin, stdout, stderr and EOF; close both sides on disconnect."""
    stopped = threading.Event()
    downstream.settimeout(timeout)
    upstream.settimeout(timeout)

    def copy_input():
        try:
            while not stopped.is_set() and not downstream.closed:
                if downstream.recv_ready():
                    data = downstream.recv(32768)
                    if data:
                        upstream.sendall(data)
                        continue
                if downstream.eof_received:
                    upstream.shutdown_write()
                    return
                time.sleep(0.01)
        except (OSError, EOFError):
            stopped.set()

    reader = threading.Thread(target=copy_input, daemon=True)
    reader.start()
    status_sent = False
    output_eof = False
    try:
        while not stopped.is_set() and not downstream.closed:
            while upstream.recv_ready():
                downstream.sendall(upstream.recv(32768))
            while upstream.recv_stderr_ready():
                downstream.sendall_stderr(upstream.recv_stderr(32768))
            if upstream.exit_status_ready() and not status_sent:
                # An exit-status request can precede the final output/EOF.
                status = upstream.recv_exit_status()
                downstream.send_exit_status(status if status >= 0 else 1)
                status_sent = True
            if upstream.eof_received and not output_eof:
                if upstream.recv_ready() or upstream.recv_stderr_ready():
                    continue
                # EOF closes only remote output; stdin may still be open.
                downstream.shutdown_write()
                output_eof = True
            if status_sent and output_eof:
                return
            if upstream.closed:
                return
            time.sleep(0.01)
    except (socket.timeout, OSError, EOFError):
        stopped.set()
    finally:
        stopped.set()
        try:
            upstream.close()
        except (OSError, EOFError):
            pass
        reader.join(1)
