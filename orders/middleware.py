from django.http import JsonResponse

MIN_EXTENSION_VERSION = "1.5.2"


def _parse_version(v: str):
    """
    "1.5.10" -> (1, 5, 10). Некорректную строку считаем ниже любой
    настоящей версии (0,) — так и отсутствие заголовка, и мусор в нём
    одинаково не проходят гейт.
    """
    try:
        return tuple(int(part) for part in v.strip().split("."))
    except (AttributeError, ValueError):
        return (0,)


class RequireExtensionVersionMiddleware:
    """
    Расширение (minin-p2p/) не публикуется в Chrome Web Store и не имеет
    автообновления (устанавливается вручную через "Load unpacked") — поэтому
    версия на клиенте не обновляется сама по себе. Чтобы гарантировать, что
    сервер принимает данные только от актуальной версии расширения, каждый
    запрос к /api/ обязан присылать заголовок X-Extension-Version не ниже
    MIN_EXTENSION_VERSION. Расширение шлёт его из auth.js
    (createAuthHeaders/uploadScreenshot), взято из
    chrome.runtime.getManifest().version.

    ИСПРАВЛЕНО: раньше требовалось ТОЧНОЕ совпадение с одной версией — при
    каждом новом релизе (1.5.2 -> 1.5.3 и т.д.) это заново отрубало всех,
    кто ещё не успел обновиться, даже с версией НОВЕЕ минимальной. Теперь
    сравниваем версии по-настоящему (1, 5, 10) > (1, 5, 2), а не строкой —
    пропускаем любую версию >= MIN_EXTENSION_VERSION.

    По прямому запросу (сессия §..) включено сразу, без раскатки — все
    версии расширения ниже MIN_EXTENSION_VERSION у трейдеров перестают
    синкать ордера/получать чеки до ручного обновления расширения.
    """

    def __init__(self, get_response):
        self.get_response = get_response
        self.min_version = _parse_version(MIN_EXTENSION_VERSION)

    def __call__(self, request):
        if request.path.startswith("/api/"):
            version = request.headers.get("X-Extension-Version")
            if version is None or _parse_version(version) < self.min_version:
                return JsonResponse(
                    {
                        "message": (
                            f"Обновите расширение до версии {MIN_EXTENSION_VERSION} или новее — "
                            "текущая версия больше не поддерживается."
                        ),
                        "required_version": MIN_EXTENSION_VERSION,
                    },
                    status=426,
                )
        return self.get_response(request)
