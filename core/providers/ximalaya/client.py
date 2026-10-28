"""喜马拉雅开放平台客户端，仅供本地曲库标签搜索使用。"""

import base64
import hashlib
import hmac
import json
import secrets
import time

import requests

# 官方签名文档公布的测试应用信息，供免申请的公开内容搜索使用。
_APP_KEY = "b617866c20482d133d5de66fceb37da3"
_APP_SECRET = "4d8e605fa7ed546c4bcb33dee1381179"
_SERVER_AUTH_KEY = "z0hh5l9A"
_DEVICE_ID = "32cc6f279c7a11e9a26e0235d2b38928"
_BASE_URL = "https://api.ximalaya.com"


class XimalayaClient:
    """封装喜马拉雅服务端搜索接口，不参与下载平台注册。"""

    def __init__(self):
        """创建隔离的 HTTP 会话，避免共享其他音乐平台的请求状态。"""
        self.session = requests.Session()
        self.session.headers.update({
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            "X-Use-V2-Error-Code": "true",
            "User-Agent": "deen-music-downloader/1.0",
        })

    @staticmethod
    def _sign(params: dict) -> str:
        """按喜马拉雅公开规范生成服务端 API 签名。"""
        canonical = "&".join(f"{key}={params[key]}" for key in sorted(params))
        encoded = base64.b64encode(canonical.encode("utf-8"))
        digest = hmac.new(
            (_APP_SECRET + _SERVER_AUTH_KEY).encode("utf-8"),
            encoded,
            hashlib.sha1,
        ).digest()
        return hashlib.md5(digest).hexdigest()

    def _get(self, endpoint: str, business_params: dict) -> dict:
        """为每次请求生成独立的公共参数，并解析双重编码的 JSON。"""
        params = {
            "app_key": _APP_KEY,
            "client_os_type": "4",
            "nonce": secrets.token_hex(16),
            "timestamp": str(int(time.time() * 1000)),
            "server_api_version": "1.0.0",
            "device_id": _DEVICE_ID,
            "device_id_type": "OAID",
            **business_params,
        }
        params["sig"] = self._sign(params)
        response = self.session.get(
            f"{_BASE_URL}{endpoint}", params=params, timeout=20
        )
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, str):
            payload = json.loads(payload)
        if not isinstance(payload, dict):
            raise ValueError("喜马拉雅接口返回格式无效")
        if payload.get("ret", 0) not in (0, "0"):
            raise ValueError(payload.get("msg") or "喜马拉雅搜索失败")
        return payload.get("data") or {}

    def search_tracks(self, keyword: str, limit: int = 20, page: int = 1) -> dict:
        """按声音标题搜索曲目，并转换为标签整理页面使用的统一字段。"""
        data = self._get("/v2/search/tracks", {
            "title": keyword,
            "page": str(max(1, int(page))),
            "count": str(min(50, max(1, int(limit)))),
        })
        tracks = data.get("tracks") or []
        items = []
        for track in tracks:
            album = track.get("subordinatedAlbum") or {}
            announcer = track.get("announcer") or {}
            items.append({
                "id": track.get("id"),
                "name": track.get("trackTitle") or "",
                "artists": announcer.get("nickname") or "",
                "album": album.get("albumTitle") or "",
                "cover_url": (
                    track.get("coverUrlLarge")
                    or track.get("coverUrlMiddle")
                    or album.get("coverUrlLarge")
                    or album.get("coverUrlMiddle")
                    or ""
                ),
            })
        return {
            "items": items,
            "total": int(data.get("totalCount") or 0),
            "page": int(data.get("curPage") or page),
        }
