
from pathlib import Path
import os
import environ

# Initialise environment reader and read `.env` if present.
env = environ.Env()
environ.Env.read_env(os.path.join(Path(__file__).resolve().parent.parent, '.env'))

BASE_DIR = Path(__file__).resolve().parent.parent

# ------------------------------------------------------------------------------
# Core settings
# ------------------------------------------------------------------------------
# Secret key: required for Django security features. Always set via `.env` in
# production. A fallback insecure value is provided for local development only.
SECRET_KEY = env('SECRET_KEY', default='django-insecure-replace-me')

# Debug mode: should be False in production. Controlled via `DEBUG` env.
DEBUG = env.bool('DEBUG', default=False)

# Allowed hosts: a comma-separated list of hosts/domains that may serve the app.
# Use `.env` to specify your domain/IP (e.g. "mininp2p.ru,89.169.143.100").
ALLOWED_HOSTS = env.list('ALLOWED_HOSTS', default=['127.0.0.1', 'localhost'])

# CSRF trusted origins: used when your frontend runs on a different domain or
# protocol. Provide full origins (including scheme) in `.env` like
# "https://mininp2p.ru,http://127.0.0.1". Empty by default for local use.
CSRF_TRUSTED_ORIGINS = env.list('CSRF_TRUSTED_ORIGINS', default=[])

# ------------------------------------------------------------------------------
# Applications and middleware
# ------------------------------------------------------------------------------
INSTALLED_APPS = [
    'django.contrib.admin',
    'django.contrib.auth',
    'django.contrib.contenttypes',
    'django.contrib.sessions',
    'django.contrib.messages',
    'django.contrib.staticfiles',
    'django.contrib.humanize',
    # Third‑party apps
    'rest_framework',
    'rest_framework.authtoken',
    'corsheaders',
    'storages',
    # Your apps
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

# ------------------------------------------------------------------------------
# Database configuration
# ------------------------------------------------------------------------------
# Prefer DATABASE_URL in `.env`, fallback to a local Postgres for development.
DATABASES = {
    'default': env.db('DATABASE_URL', default='postgres://postgres:5212@127.0.0.1:5432/p2p_db')
}

# ------------------------------------------------------------------------------
# Authentication and user model
# ------------------------------------------------------------------------------
AUTH_USER_MODEL = 'orders.User'

AUTH_PASSWORD_VALIDATORS = [
    {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
    {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
    {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
    {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
]

LOGIN_URL = 'login'
LOGIN_REDIRECT_URL = 'my_orders'
LOGOUT_REDIRECT_URL = 'login'

# ------------------------------------------------------------------------------
# Internationalization
# ------------------------------------------------------------------------------
LANGUAGE_CODE = 'en-us'
TIME_ZONE = env('TIME_ZONE', default='UTC')
USE_I18N = True
USE_TZ = True

# ------------------------------------------------------------------------------
# Static and media files
# ------------------------------------------------------------------------------
# URL to use when referring to static files (collected via collectstatic).
STATIC_URL = '/static/'
# Directory to collect static files into for production (must be absolute).
STATIC_ROOT = BASE_DIR / 'staticfiles'

# Media storage (uploads). Use S3 if credentials provided; otherwise local.
if env('AWS_ACCESS_KEY_ID', default=None):
    AWS_ACCESS_KEY_ID = env('AWS_ACCESS_KEY_ID')
    AWS_SECRET_ACCESS_KEY = env('AWS_SECRET_ACCESS_KEY')
    AWS_STORAGE_BUCKET_NAME = env('AWS_STORAGE_BUCKET_NAME')
    AWS_S3_REGION_NAME = env('AWS_S3_REGION_NAME', default='ru-central1')
    AWS_S3_ENDPOINT_URL = env('AWS_S3_ENDPOINT_URL', default='https://storage.yandexcloud.net')

    AWS_S3_FILE_OVERWRITE = False
    AWS_DEFAULT_ACL = None  # do not set ACLs by default

    STORAGES = {
        'default': {'BACKEND': 'storages.backends.s3.S3Storage'},
        'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'},
    }
    MEDIA_URL = f'https://{AWS_STORAGE_BUCKET_NAME}.storage.yandexcloud.net/'
    # MEDIA_ROOT is not used when using S3 backend
else:
    MEDIA_URL = '/media/'
    MEDIA_ROOT = BASE_DIR / 'media'

# ------------------------------------------------------------------------------
# DRF and CORS configuration
# ------------------------------------------------------------------------------
# Allow CORS from all origins by default in development. Override in `.env` for
# production by setting CORS_ALLOW_ALL_ORIGINS to 'False' and specifying
# CORS_ALLOWED_ORIGINS.
CORS_ALLOW_ALL_ORIGINS = env.bool('CORS_ALLOW_ALL_ORIGINS', default=True)
CORS_ALLOWED_ORIGINS = env.list('CORS_ALLOWED_ORIGINS', default=[])
CORS_ALLOW_CREDENTIALS = True
CORS_ALLOW_PRIVATE_NETWORK = True

REST_FRAMEWORK = {
    'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework.authentication.TokenAuthentication',
        'orders.authentication.BearerTokenAuthentication',
    ],
    'DEFAULT_PERMISSION_CLASSES': [
        'rest_framework.permissions.IsAuthenticated',
    ],
}

# ------------------------------------------------------------------------------
# Celery and Redis configuration
# ------------------------------------------------------------------------------
CELERY_BROKER_URL = env('CELERY_BROKER_URL', default='redis://127.0.0.1:6379/0')
CELERY_RESULT_BACKEND = env('CELERY_RESULT_BACKEND', default=CELERY_BROKER_URL)
CELERY_ACCEPT_CONTENT = ['json']
CELERY_TASK_SERIALIZER = 'json'
CELERY_RESULT_SERIALIZER = 'json'

# ------------------------------------------------------------------------------
# Other settings
# ------------------------------------------------------------------------------
DEFAULT_AUTO_FIELD = 'django.db.models.BigAutoField'
APPEND_SLASH = False
SESSION_COOKIE_AGE = 1209600
SESSION_EXPIRE_AT_BROWSER_CLOSE = False

# When handling file uploads, Django places uploaded data into memory up to
# this size (in bytes) before writing to disk. Raising it prevents Django
# from rejecting moderately sized uploads (e.g., screenshots or documents).
# Note: Nginx or your reverse proxy must also allow uploads at least as
# large via `client_max_body_size`. Here we permit up to 10 MB per request.
DATA_UPLOAD_MAX_MEMORY_SIZE = 10 * 1024 * 1024  # 10 MB
FILE_UPLOAD_MAX_MEMORY_SIZE = DATA_UPLOAD_MAX_MEMORY_SIZE

# Logging: basic configuration to console. Extend as needed.
LOGGING = {
    'version': 1,
    'disable_existing_loggers': False,
    'handlers': {
        'console': {
            'class': 'logging.StreamHandler',
        },
    },
    'root': {
        'handlers': ['console'],
        'level': env('LOG_LEVEL', default='INFO'),
    },
}