"""AI가 생성한 것 같은 샘플 코드."""
import json
import os.path as osp
from dataclasses import dataclass, field
from typing import Optional

CONFIG_PATH = "config.json"
MAX_RETRY: int = 3
_cache = {}


@dataclass
class User:
    """사용자 정보."""
    name: str
    age: int = 0
    tags: list = field(default_factory=list)

    def greet(self) -> str:
        msg = "안녕하세요 😀"; out = f"{msg} {self.name}"
        return out


class Repository:
    """사용자 저장소."""

    def __init__(self, path: str):
        self.path = path
        self.users: list[User] = []
        self._loaded = False

    def load(self) -> None:
        if not osp.exists(self.path):
            raise FileNotFoundError(self.path)
        with open(self.path) as f:
            data = json.load(f)
        for item in data:
            self.users.append(User(**item))
        self._loaded = True

    def find(self, name: str) -> Optional[User]:
        if not self._loaded:
            self.load()
        for u in self.users:
            if u.name == name:
                return u
        return None


def load_config(path=CONFIG_PATH):
    global _cache
    if path in _cache:
        return _cache[path]
    for attempt in range(MAX_RETRY):
        try:
            with open(path) as f:
                _cache = json.load(f)
            break
        except OSError as e:
            print("retry", attempt, e)
            continue
    else:
        raise RuntimeError("config load failed")
    return _cache


def unused_helper(x, *args, **kwargs):
    return [y * 2 for y in args if y]


async def fetch(url: str, timeout: float = 1.0):
    result = await download(url)
    return result


def main():
    cfg = load_config()
    repo = Repository(cfg["users"])
    user = repo.find("alice")
    match user:
        case None:
            print("not found")
        case User(name=n):
            print(user.greet())


if __name__ == "__main__":
    main()
