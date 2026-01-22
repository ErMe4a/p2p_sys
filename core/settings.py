"""
Django settings for core project.
Optimized for Yandex Cloud Deployment + Local Windows Dev.
"""

from pathlib import Path
import os
import environ  # Импортируем библиотеку для работы с .env

# Инициализация environ
env = environ.Env()
# Читаем файл .env, если он существует (на сервере он будет, локально - опционально)
environ.Env.read_env(os.path.join(Path(__file__).resolve().parent.parent, '.env'))

# Build paths inside the project like this: BASE_DIR / 'subdir'.
BASE_DIR = Path(__file__).resolve().parent.parent

# ==============================================================================
# CORE SETTINGS
# ==============================================================================

# Берём из .env, иначе используем твой старый ключ (для локальной разработки)
SECRET_KEY = env('SECRET_KEY', default='django-insecure-d6ff3d&08bv6d1%8szjv#w&(w2k2^2bcftpc9=f!b-+9-b^^+h')

# На сервере будет False (из .env), локально True (по умолчанию)
DEBUG = env.bool('DEBUG', default=True)

# Список хостов. На сервере пропишем IP и домен. Локально работает localhost.
ALLOWED_HOSTS = env.list('ALLOWED_HOSTS', default=['surest-evasively-robbie.ngrok-free.dev', '127.0.0.1', 'localhost'])

# CSRF: важно для ngrok и продакшена
CSRF_TRUSTED_ORIGINS = env.list('CSRF_TRUSTED_ORIGINS', default=['https://surest-evasively-robbie.ngrok-free.dev'])


# ==============================================================================
# APPS & MIDDLEWARE
# ==============================================================================

INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'django.contrib.humanize',
    
    # Сторонние библиотеки
    'rest_framework',
    'rest_framework.authtoken',
    'corsheaders',
    'storages',  # Добавлено для работы с S3 (Yandex Object Storage)
    
    # Наше приложение
    'orders',
]

MIDDLEWARE = [
    'corsheaders.middleware.CorsMiddleware',
    'django.middleware.security.SecurityMiddleware',
    'django.contrib.sessions.middleware.SessionMiddleware',
    'django.middleware.common.CommonMiddleware',
    'django.middleware.csrf.CsrfViewMiddleware',
    'django.contrib.auth.middleware.AuthenticationMiddleware',
    'django.contrib.messages.middleware.MessageMiddleware',
    'django.middleware.clickjacking.XFrameOptionsMiddleware',
]

ROOT_URLCONF = 'core.urls'

TEMPLATES = [
    {
        'BACKEND': 'django.template.backends.django.DjangoTemplates',
        'DIRS': [BASE_DIR / 'templates'],
        'APP_DIRS': True,
        'OPTIONS': {
            'context_processors': [
                'django.template.context_processors.request',
                'django.contrib.auth.context_processors.auth',
                'django.contrib.messages.context_processors.messages',
            ],
        },
    },
]

WSGI_APPLICATION = 'core.wsgi.application'


# ==============================================================================
# DATABASE (PostgreSQL)
# ==============================================================================

# Логика: Если в .env есть DATABASE_URL (на сервере), используем её.
# Если нет — используем твои локальные настройки Postgres.
DATABASES = {
    'default': env.db(
        'DATABASE_URL',
        default='postgres://postgres:5212@127.0.0.1:5432/p2p_db'
    )
}


# ==============================================================================
# AUTH & PASSWORD VALIDATION
# ==============================================================================

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

AUTH_USER_MODEL = 'orders.User'

# Redirects
LOGIN_URL = 'login'
LOGIN_REDIRECT_URL = 'my_orders'
LOGOUT_REDIRECT_URL = 'login'


# ==============================================================================
# INTERNATIONALIZATION
# ==============================================================================

LANGUAGE_CODE = 'en-us'
TIME_ZONE = 'UTC'
USE_I18N = True
USE_TZ = True


# ==============================================================================
# STATIC & MEDIA FILES (S3 vs Local)
# ==============================================================================

STATIC_URL = 'static/'
STATIC_ROOT = os.path.join(BASE_DIR, 'static') # Важно для collectstatic на сервере

# Проверяем, есть ли ключи от Яндекса в .env. Если есть — включаем S3.
if env('AWS_ACCESS_KEY_ID', default=None):
    # --- НАСТРОЙКИ ДЛЯ СЕРВЕРА (Yandex Cloud) ---
    AWS_ACCESS_KEY_ID = env('AWS_ACCESS_KEY_ID')
    AWS_SECRET_ACCESS_KEY = env('AWS_SECRET_ACCESS_KEY')
    AWS_STORAGE_BUCKET_NAME = env('AWS_STORAGE_BUCKET_NAME')
    AWS_S3_REGION_NAME = 'ru-central1'
    AWS_S3_ENDPOINT_URL = 'https://storage.yandexcloud.net'
    
    AWS_S3_FILE_OVERWRITE = False
    AWS_DEFAULT_ACL = None  # Важно для Yandex (private/public bucket policy)

    # Храним медиа (скриншоты) в облаке
    STORAGES = {
        "default": {
            "BACKEND": "storages.backends.s3.S3Storage",
        },
        "staticfiles": {
            "BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage",
        },
    }
    MEDIA_URL = f'https://{AWS_STORAGE_BUCKET_NAME}.storage.yandexcloud.net/'

else:
    # --- НАСТРОЙКИ ДЛЯ WINDOWS (Локально) ---
    MEDIA_URL = '/media/'
    MEDIA_ROOT = os.path.join(BASE_DIR, 'media')


# ==============================================================================
# REST FRAMEWORK & CORS
# ==============================================================================

CORS_ALLOW_ALL_ORIGINS = True # Разрешаем всем (для тестов/расширений)
CORS_ALLOW_CREDENTIALS = True
CORS_ALLOW_PRIVATE_NETWORK = True # Важно для localhost запросов

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
# CELERY & REDIS (Очереди)
# ==============================================================================

# Если в .env не задан брокер, используем локальный Redis (если стоит) или заглушку
CELERY_BROKER_URL = env('CELERY_BROKER_URL', default='redis://127.0.0.1:6379/0')
CELERY_RESULT_BACKEND = env('CELERY_BROKER_URL', default='redis://127.0.0.1:6379/0')
CELERY_ACCEPT_CONTENT = ['json']
CELERY_TASK_SERIALIZER = 'json'
CELERY_RESULT_SERIALIZER = 'json'


# ==============================================================================
# OTHER SETTINGS
# ==============================================================================

DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
APPEND_SLASH = False
SESSION_COOKIE_AGE = 1209600
SESSION_EXPIRE_AT_BROWSER_CLOSE = False