"""Terminate a worker owned by this service, including its Windows children."""
import os
import queue
import subprocess
import threading


def stop_worker(process):
    if process.poll() is not None:
        return
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'],
                       stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def line_reader(process):
    """Queue the worker's stdout lines so replies can be awaited with a timeout; '' marks EOF."""
    lines = queue.Queue()

    def pump():
        try:
            for line in iter(process.stdout.readline, ''):
                lines.put(line)
        except (OSError, ValueError):
            pass
        lines.put('')

    threading.Thread(target=pump, name=f'worker-{process.pid}-stdout', daemon=True).start()
    return lines
