"""
Защита от перебора пароля (брутфорс-ботов) — единая точка для ВСЕХ входов
в систему: /login/ (трейдеры), /p2p-admin/login/ (кастомная админка),
/admin/ (встроенная админка Django) и /api/auth/login (расширение).

Все четыре в итоге вызывают django.contrib.auth.authenticate(), а она
проходит по AUTHENTICATION_BACKENDS (core/settings.py) — поэтому один
бэкенд-обёртка над стандартным ModelBackend закрывает все точки входа
сразу, без правки каждого view отдельно.

Счётчик неудачных попыток хранится в общем кэше (Redis, см.
core/settings.py CACHES) — это важно, потому что на проде несколько
процессов gunicorn, и счётчик "в памяти процесса" каждый воркер видел
бы отдельно, блокировка не работала бы.
"""
import logging

from django.contrib.auth.backends import ModelBackend
from django.core.cache import cache

logger = logging.getLogger(__name__)

LOGIN_MAX_ATTEMPTS = 5
LOGIN_LOCKOUT_SECONDS = 15 * 60  # 15 минут


def client_ip(request) -> str:
    if not request:
        return "unknown"
    xff = request.META.get("HTTP_X_FORWARDED_FOR")
    if xff:
        return xff.split(",")[0].strip()
    return request.META.get("REMOTE_ADDR", "unknown")


def _key(request, username: str) -> str:
    return f"loginlock:{client_ip(request)}:{(username or '').strip().lower()}"


def is_locked_out(request, username: str) -> bool:
    return cache.get(_key(request, username), 0) >= LOGIN_MAX_ATTEMPTS


def seconds_left(request, username: str) -> int:
    """Сколько ещё держится блокировка — для сообщения пользователю."""
    ttl = cache.ttl(_key(request, username)) if hasattr(cache, "ttl") else None
    return ttl or LOGIN_LOCKOUT_SECONDS


def register_failure(request, username: str) -> int:
    key = _key(request, username)
    try:
        count = cache.incr(key)
        cache.touch(key, LOGIN_LOCKOUT_SECONDS)
    except ValueError:
        # ключа ещё не было
        count = 1
        cache.set(key, count, timeout=LOGIN_LOCKOUT_SECONDS)
    if count >= LOGIN_MAX_ATTEMPTS:
        logger.warning(
            "Login lockout: IP=%s username=%s — %d неверных попыток подряд, блокировка на %d мин.",
            client_ip(request), username, count, LOGIN_LOCKOUT_SECONDS // 60,
        )
    return count


def register_success(request, username: str) -> None:
    cache.delete(_key(request, username))


class LockoutModelBackend(ModelBackend):
    """
    Обёртка над стандартным ModelBackend: после LOGIN_MAX_ATTEMPTS неверных
    паролей подряд для одной и той же пары (IP, логин) дальнейшие попытки
    отклоняются на LOGIN_LOCKOUT_SECONDS — без единого запроса к базе паролей,
    т.е. это не даёт боту даже проверить очередной пароль, пока не истечёт
    блокировка. Правильный пароль сбрасывает счётчик.
    """

    def authenticate(self, request, username=None, password=None, **kwargs):
        if username is None or password is None:
            return None

        if is_locked_out(request, username):
            logger.info(
                "Login отклонён (активна блокировка): IP=%s username=%s",
                client_ip(request), username,
            )
            return None

        user = super().authenticate(request, username=username, password=password, **kwargs)

        if user is None:
            register_failure(request, username)
        else:
            register_success(request, username)

        return user
