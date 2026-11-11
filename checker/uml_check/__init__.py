"""Автоматическая проверка UML-диаграмм классов на соответствие эталонам.

Библиотечный API (ТЗ п. 11):

    from uml_check import check, load_config
    report = check(load_config("task_config.yaml"), student_text)

Проверка детерминирована: один вход -> один выход. Ни сети, ни LLM,
ни исполнения студенческого файла - он только разбирается как текст.
"""

from .config import Config, load_config, load_config_data  # noqa: F401
from .api import check, check_files  # noqa: F401
from .version import TOOL_VERSION, PARSER_VERSION  # noqa: F401

__all__ = [
    "Config",
    "load_config",
    "load_config_data",
    "check",
    "check_files",
    "TOOL_VERSION",
    "PARSER_VERSION",
]
