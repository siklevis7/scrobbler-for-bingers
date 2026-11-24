# PyInstaller recipe for BingersScrobbler.exe (a folder build, wrapped by installer.iss).
# Build from the repo root:  pyinstaller --noconfirm --clean packaging/bingers-scrobbler.spec
# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules, copy_metadata

ROOT = Path(SPECPATH).parent
ASSETS = ROOT / "src" / "bingers_scrobbler" / "assets"

# guessit and babelfish load JSON/text data and plugins at runtime.
datas = [(str(ASSETS), "bingers_scrobbler/assets")]
hiddenimports = ["pystray._win32", "PIL._tkinter_finder"]
for pkg in ("guessit", "babelfish", "rebulk"):
    datas += collect_data_files(pkg)
    datas += copy_metadata(pkg)
    hiddenimports += collect_submodules(pkg)

a = Analysis(
    [str(ROOT / "packaging" / "launcher.py")],
    pathex=[str(ROOT / "src")],
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["pytest", "_pytest"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="BingersScrobbler",
    icon=str(ASSETS / "icon.ico"),
    console=False,
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="BingersScrobbler", upx=False)
