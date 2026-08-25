from django.http import JsonResponse

REQUIRED_EXTENSION_VERSION = "1.5.2"


class RequireExtensionVersionMiddleware:
    """
    Расширение (minin-p2p/) не публикуется в Chrome Web Store и не имеет
    автообновления (устанавливается вручную через "Load unpacked") — поэтому
    версия на клиенте не обновляется сама по себе. Чтобы гарантировать, что
    сервер принимает данные только от актуальной версии расширения, каждый
    запрос к /api/ обязан присылать заголовок X-Extension-Version с точным
    совпадением REQUIRED_EXTENSION_VERSION. Расширение шлёт его из
    auth.js (createAuthHeaders/uploadScreenshot), взято из
    chrome.runtime.getManifest().version.

    По прямому запросу (сессия §..) включено сразу, без раскатки — все
    версии расширения ниже REQUIRED_EXTENSION_VERSION у трейдеров перестают
    синкать ордера/получать чеки до ручного обновления расширения.
    """

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith("/api/"):
            version = request.headers.get("X-Extension-Version")
            if version != REQUIRED_EXTENSION_VERSION:
                return JsonResponse(
                    {
                        "message": (
                            f"Обновите расширение до версии {REQUIRED_EXTENSION_VERSION} — "
                            "текущая версия больше не поддерживается."
                        ),
                        "required_version": REQUIRED_EXTENSION_VERSION,
                    },
                    status=426,
                )
        return self.get_response(request)
