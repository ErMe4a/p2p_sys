"""
Django settings for core project.
Optimized for Yandex Cloud Deployment + Local Dev.
"""

from pathlib import Path
import os
import environ

# ==============================================================================
# PATHS & ENV
# ==============================================================================

BASE_DIR = Path(__file__).resolve().parent.parent

env = environ.Env(
    DEBUG=(bool, False),
)

# Читаем .env если он есть
environ.Env.read_env(os.path.join(BASE_DIR, ".env"))

# ==============================================================================
# CORE SETTINGS
# ==============================================================================

# ВАЖНО: не держим дефолтный секрет в коде
SECRET_KEY = env("SECRET_KEY")

DEBUG = env.bool("DEBUG", default=False)

ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=["127.0.0.1", "localhost"])

CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS", default=[])

# Если ты за ALB/nginx и используешь HTTPS снаружи:
# Это важно, чтобы Django понимал что запрос был https и корректно ставил secure cookies/redirects
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# В проде желательно включить:
SESSION_COOKIE_SECURE = env.bool("SESSION_COOKIE_SECURE", default=not DEBUG)
CSRF_COOKIE_SECURE = env.bool("CSRF_COOKIE_SECURE", default=not DEBUG)

# ==============================================================================
# APPS & MIDDLEWARE
# ==============================================================================

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "django.contrib.humanize",

    # Сторонние
    "rest_framework",
    "rest_framework.authtoken",
    "corsheaders",

    # Для Yandex Object Storage (S3)
    "storages",

    # Наше
    "orders",
]

MIDDLEWARE = [
    "corsheaders.middleware.CorsMiddleware",
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "core.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

WSGI_APPLICATION = "core.wsgi.application"

# ==============================================================================
# DATABASE (PostgreSQL)
# ==============================================================================

# На сервере удобнее хранить одной строкой:
# DATABASE_URL=postgres://user:pass@host:5432/dbname
DATABASES = {
    "default": env.db("DATABASE_URL")
}

# ==============================================================================
# AUTH
# ==============================================================================

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

AUTH_USER_MODEL = "orders.User"

LOGIN_URL = "login"
LOGIN_REDIRECT_URL = "my_orders"
LOGOUT_REDIRECT_URL = "login"

# ==============================================================================
# INTERNATIONALIZATION
# ==============================================================================

LANGUAGE_CODE = "en-us"
TIME_ZONE = env("TIME_ZONE", default="UTC")
USE_I18N = True
USE_TZ = True

# ==============================================================================
# STATIC & MEDIA
# ==============================================================================

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# Локально можно хранить media на диске, но для HA (2 ВМ) — обязательно S3 (Object Storage)
USE_S3 = env.bool("USE_S3", default=False)

MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

if USE_S3:
    AWS_ACCESS_KEY_ID = env("AWS_ACCESS_KEY_ID")
    AWS_SECRET_ACCESS_KEY = env("AWS_SECRET_ACCESS_KEY")
    AWS_STORAGE_BUCKET_NAME = env("AWS_STORAGE_BUCKET_NAME")

    # Для Yandex Object Storage:
    AWS_S3_REGION_NAME = env("AWS_S3_REGION_NAME", default="ru-central1")
    AWS_S3_ENDPOINT_URL = env("AWS_S3_ENDPOINT_URL", default="https://storage.yandexcloud.net")

    AWS_S3_FILE_OVERWRITE = False
    AWS_DEFAULT_ACL = None

    # Хранилище по умолчанию (MEDIA) -> S3
    STORAGES = {
        "default": {
            "BACKEND": "storages.backends.s3.S3Storage",
        },
        "staticfiles": {
            "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
        },
    }

    # Если бакет публичный — будет работать напрямую.
    # Если бакет приватный — лучше раздавать presigned URL (отдельно настроим).
    MEDIA_URL = f"https://{AWS_STORAGE_BUCKET_NAME}.storage.yandexcloud.net/"

# ==============================================================================
# CORS / CSRF
# ==============================================================================

# Для релиза лучше выключить ALL_ORIGINS и задать список
CORS_ALLOW_ALL_ORIGINS = env.bool("CORS_ALLOW_ALL_ORIGINS", default=DEBUG)
CORS_ALLOWED_ORIGINS = env.list("CORS_ALLOWED_ORIGINS", default=[])

CORS_ALLOW_CREDENTIALS = True
CORS_ALLOW_PRIVATE_NETWORK = True

APPEND_SLASH = False

# ==============================================================================
# REST FRAMEWORK
# ==============================================================================

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.TokenAuthentication",
        "orders.authentication.BearerTokenAuthentication",
    ],
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
}

# ==============================================================================
# CELERY & REDIS (если используешь фоновые задачи)
# ==============================================================================

CELERY_BROKER_URL = env("CELERY_BROKER_URL", default="redis://127.0.0.1:6379/0")
CELERY_RESULT_BACKEND = env("CELERY_RESULT_BACKEND", default=CELERY_BROKER_URL)
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_SERIALIZER = "json"
CELERY_RESULT_SERIALIZER = "json"

# ==============================================================================
# OTHER
# ==============================================================================

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

SESSION_COOKIE_AGE = 1209600
SESSION_EXPIRE_AT_BROWSER_CLOSE = False

# Небольшое логирование (полезно на сервере)
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "root": {"handlers": ["console"], "level": env("LOG_LEVEL", default="INFO")},
}
