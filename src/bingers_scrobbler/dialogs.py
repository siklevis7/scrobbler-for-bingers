"""Small Tkinter windows for the tray app: text prompts, messages and the watch history."""

from __future__ import annotations

import tkinter as tk
import webbrowser
from tkinter import messagebox, ttk
from typing import Any

APP_TITLE = "Bingers Scrobbler"


def _bring_to_front(win: tk.Toplevel) -> None:
    win.update_idletasks()
    w, h = win.winfo_reqwidth(), win.winfo_reqheight()
    x = (win.winfo_screenwidth() - w) // 2
    y = (win.winfo_screenheight() - h) // 3
    win.geometry(f"+{x}+{y}")
    win.attributes("-topmost", True)
    win.lift()
    win.focus_force()


def ask_string(
    root: tk.Tk,
    title: str,
    message: str,
    *,
    secret: bool = False,
    initial: str = "",
    link: tuple[str, str] | None = None,
) -> str | None:
    """A prompt with a text box. `link` is (button label, URL). Returns None on Cancel."""
    win = tk.Toplevel(root)
    win.title(f"{title} - {APP_TITLE}")
    win.resizable(False, False)
    result: dict[str, str | None] = {"value": None}

    frame = ttk.Frame(win, padding=18)
    frame.pack(fill="both", expand=True)
    ttk.Label(frame, text=message, wraplength=420, justify="left").pack(anchor="w")
    if link:
        label, url = link
        ttk.Button(frame, text=label, command=lambda: webbrowser.open(url)).pack(anchor="w", pady=(10, 0))

    var = tk.StringVar(value=initial)
    entry = ttk.Entry(frame, textvariable=var, width=52, show="•" if secret else "")
    entry.pack(fill="x", pady=(12, 0))

    if secret:
        shown = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            frame,
            text="Show",
            variable=shown,
            command=lambda: entry.configure(show="" if shown.get() else "•"),
        ).pack(anchor="w", pady=(4, 0))

    def ok(_event: Any = None) -> None:
        result["value"] = var.get().strip()
        win.destroy()

    def cancel(_event: Any = None) -> None:
        win.destroy()

    buttons = ttk.Frame(frame)
    buttons.pack(fill="x", pady=(14, 0))
    ttk.Button(buttons, text="Cancel", command=cancel).pack(side="right")
    ttk.Button(buttons, text="OK", command=ok).pack(side="right", padx=(0, 8))

    win.bind("<Return>", ok)
    win.bind("<Escape>", cancel)
    win.protocol("WM_DELETE_WINDOW", cancel)
    _bring_to_front(win)
    entry.focus_set()
    win.grab_set()
    root.wait_window(win)
    return result["value"]


def info(root: tk.Tk, message: str, title: str = APP_TITLE) -> None:
    _with_anchor(root, lambda parent: messagebox.showinfo(title, message, parent=parent))


def error(root: tk.Tk, message: str, title: str = APP_TITLE) -> None:
    _with_anchor(root, lambda parent: messagebox.showerror(title, message, parent=parent))


def confirm(root: tk.Tk, message: str, title: str = APP_TITLE) -> bool:
    return bool(_with_anchor(root, lambda parent: messagebox.askyesno(title, message, parent=parent)))


def _with_anchor(root: tk.Tk, show: Any) -> Any:
    """Give a message box a tiny topmost parent so it doesn't open behind other windows."""
    anchor = tk.Toplevel(root)
    anchor.overrideredirect(True)
    anchor.geometry("1x1+0+0")
    anchor.attributes("-topmost", True)
    anchor.attributes("-alpha", 0.0)
    try:
        return show(anchor)
    finally:
        anchor.destroy()


def show_history(root: tk.Tk, entries: list[dict[str, Any]], open_file: Any = None) -> None:
    win = tk.Toplevel(root)
    win.title(f"Watch history - {APP_TITLE}")
    win.geometry("640x420")

    frame = ttk.Frame(win, padding=10)
    frame.pack(fill="both", expand=True)
    columns = ("time", "what", "result")
    tree = ttk.Treeview(frame, columns=columns, show="headings")
    for col, label, width in (("time", "When", 150), ("what", "What", 260), ("result", "Result", 180)):
        tree.heading(col, text=label)
        tree.column(col, width=width, anchor="w")
    scroll = ttk.Scrollbar(frame, orient="vertical", command=tree.yview)
    tree.configure(yscrollcommand=scroll.set)
    tree.pack(side="left", fill="both", expand=True)
    scroll.pack(side="right", fill="y")

    for entry in entries:
        when = str(entry.get("time", "")).replace("T", " ")[:16]
        tree.insert("", "end", values=(when, entry.get("what", ""), entry.get("result", "")))
    if not entries:
        tree.insert("", "end", values=("", "Nothing scrobbled yet", ""))

    bottom = ttk.Frame(win, padding=(10, 0, 10, 10))
    bottom.pack(fill="x")
    ttk.Button(bottom, text="Close", command=win.destroy).pack(side="right")
    if open_file is not None:
        ttk.Button(bottom, text="Open file", command=open_file).pack(side="right", padx=(0, 8))
    _bring_to_front(win)
    win.after(300, lambda: win.attributes("-topmost", False))
