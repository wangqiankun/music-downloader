"""本地音乐库扫描与标签补全"""

import os
from pathlib import Path

from mutagen import File as MutagenFile
from mutagen.flac import FLAC
from mutagen.mp3 import MP3

from core.metadata import write_tags

SUPPORTED_AUDIO_SUFFIXES = {".mp3", ".flac", ".ogg", ".opus"}
MAX_SCAN_ITEMS = 5000


def _tag_value(tags, key: str, multiple: bool = False) -> str:
    """将 Mutagen 的 easy tag 统一读成短字符串"""
    try:
        value = tags.get(key, "") if tags else ""
    except (AttributeError, TypeError):
        return ""
    if isinstance(value, (list, tuple)):
        value = " / ".join(str(item).strip() for item in value if str(item).strip()) \
            if multiple else (value[0] if value else "")
    return str(value or "").strip()


def _has_cover(path: Path) -> bool:
    """检测 MP3、FLAC、Vorbis 与 Opus 中是否已有内嵌封面"""
    try:
        audio = MutagenFile(str(path))
        if isinstance(audio, MP3):
            return bool(audio.tags and audio.tags.getall("APIC"))
        if isinstance(audio, FLAC):
            return bool(audio.pictures)
        tags = getattr(audio, "tags", None)
        return bool(tags and (tags.get("metadata_block_picture") or tags.get("coverart")))
    except Exception:
        return False


def read_file_metadata(path: Path) -> dict:
    """读取单个音频文件的现有标签与内嵌封面状态"""
    audio = MutagenFile(str(path), easy=True)
    if audio is None:
        raise ValueError("无法识别音频格式或文件标签")
    tags = getattr(audio, "tags", None)
    return {
        "title": _tag_value(tags, "title"),
        "artist": _tag_value(tags, "artist", multiple=True),
        "album": _tag_value(tags, "album"),
        "albumartist": _tag_value(tags, "albumartist", multiple=True),
        "year": _tag_value(tags, "date"),
        "track_no": _tag_value(tags, "tracknumber"),
        "disc_no": _tag_value(tags, "discnumber"),
        "has_cover": _has_cover(path),
    }


def scan_library(root: Path, song_records: dict[str, object]) -> tuple[list[dict], bool]:
    """扫描目录下受支持的音频，按文件路径关联下载历史"""
    root = root.resolve(strict=True)
    results: list[dict] = []
    truncated = False
    for current, dirs, filenames in os.walk(root, followlinks=False):
        dirs[:] = sorted(directory for directory in dirs if not (Path(current) / directory).is_symlink())
        for filename in sorted(filenames):
            path = Path(current) / filename
            if path.suffix.lower() not in SUPPORTED_AUDIO_SUFFIXES or path.is_symlink():
                continue
            try:
                resolved = path.resolve(strict=True)
                resolved.relative_to(root)
                file_tags = read_file_metadata(resolved)
                source = song_records.get(str(resolved))
                missing = [key for key in ("title", "artist", "album") if not file_tags[key]]
                if not file_tags["has_cover"]:
                    missing.append("cover")
                results.append({
                    "relative_path": resolved.relative_to(root).as_posix(),
                    "name": resolved.name,
                    "size": resolved.stat().st_size,
                    "tags": file_tags,
                    "missing": missing,
                    "source": ({
                        "platform": source.platform,
                        "song_id": str(source.id),
                        "name": source.name,
                        "artists": source.artists or "",
                        "album": source.album or "",
                    } if source else None),
                    "search_hint": " ".join(value for value in (
                        file_tags["title"], file_tags["artist"],
                        "" if file_tags["title"] else resolved.stem.replace(" - ", " "),
                    ) if value).strip(),
                    "read_error": "",
                })
            except Exception as exc:
                if len(results) < MAX_SCAN_ITEMS:
                    results.append({
                        "relative_path": path.relative_to(root).as_posix(),
                        "name": filename,
                        "size": 0,
                        "tags": {},
                        "missing": ["title", "artist", "album", "cover"],
                        "source": None,
                        "search_hint": path.stem.replace(" - ", " "),
                        "read_error": str(exc)[:160],
                    })
            if len(results) > MAX_SCAN_ITEMS:
                truncated = True
                results.pop()
                break
        if truncated:
            break
    results.sort(key=lambda item: item["relative_path"].casefold())
    return results, truncated


def apply_file_metadata(path: Path, metadata: dict, overwrite: bool = False) -> dict:
    """将来源元数据与现有标签合并后写回音频文件"""
    current = read_file_metadata(path)
    fallback = metadata.get("fallback") or {}
    title = metadata.get("title") or fallback.get("name") or fallback.get("title") or ""
    artist = metadata.get("artist") or fallback.get("artists") or fallback.get("artist") or ""
    album = metadata.get("album") or fallback.get("album") or ""

    def choose(field: str, incoming: str) -> str:
        """默认保留文件现有值；覆盖模式优先采用来源非空值"""
        old = str(current.get(field) or "").strip()
        new = str(incoming or "").strip()
        return (new or old) if overwrite else (old or new)

    cover_url = str(metadata.get("cover_url") or "").strip()
    replace_cover = bool(overwrite and cover_url)
    preserve_cover = current["has_cover"] and not replace_cover
    tags = {
        "title": choose("title", title),
        "artist": choose("artist", artist),
        "album": choose("album", album),
        "year": choose("year", str(metadata.get("year") or "")),
        "track_no": choose("track_no", str(metadata.get("track_no") or "")),
        "disc_no": choose("disc_no", str(metadata.get("disc_no") or "")),
        "albumartist": choose("albumartist", str(metadata.get("albumartist") or "")),
        "cover_url": cover_url if (replace_cover or not current["has_cover"]) else "",
        "lyric": "",
        "tlyric": "",
    }
    if not any(tags[key] for key in ("title", "artist", "album")) and not tags["cover_url"]:
        raise ValueError("来源没有可写入的标题、歌手、专辑或封面信息")
    if not write_tags(path, tags, write_lyric=False, preserve_cover=preserve_cover):
        raise ValueError("音频标签写入失败，请检查文件权限与格式")
    return read_file_metadata(path)
