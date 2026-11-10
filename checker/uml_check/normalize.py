"""Нормализация имён (ТЗ п. 3.1).

Имя приводится к списку лемм: регистр снимается, ё заменяется на е,
разделители и границы CamelCase режут имя на слова, русские слова
лемматизируются pymorphy3, английские - простой стеммингом.

Нормализованная форма - слова через пробел ("списокСчетов" -> "список счёт");
для метрик расстояния используется та же форма без пробелов.
"""

import re
from functools import lru_cache
from typing import Dict, Iterable, List, Optional, Tuple

CYRILLIC = re.compile(r"[а-яёa-z]*[а-яё]", re.IGNORECASE)
HAS_CYRILLIC = re.compile(r"[а-яё]", re.IGNORECASE)
SEPARATORS = re.compile(r"[\s_\-.,;:/\|()\[\]{}<>\"'`~!?@#$%^&*=+]+")
CAMEL = re.compile(r"(?<=[a-zа-яё0-9])(?=[A-ZА-Я])|(?<=[A-ZА-Я])(?=[A-ZА-Я][a-zа-яё])")

_morph = None
_morph_version = None


def morph_version() -> Optional[str]:
    """Версия морфологии для meta отчёта; None, если pymorphy3 недоступен."""
    _analyzer()
    return _morph_version


def _analyzer():
    """pymorphy3 загружается один раз и лениво: словарь весит десятки мегабайт."""
    global _morph, _morph_version
    if _morph is not None or _morph_version == "unavailable":
        return _morph
    try:
        import pymorphy3
        import pymorphy3_dicts_ru

        _morph = pymorphy3.MorphAnalyzer()
        _morph_version = (
            f"pymorphy3 {pymorphy3.__version__} / dicts-ru {pymorphy3_dicts_ru.__version__}"
        )
    except Exception:
        _morph = None
        _morph_version = "unavailable"
    return _morph


def fold(text: str) -> str:
    return str(text or "").casefold().replace("ё", "е")


def split_words(text: str) -> List[str]:
    """Имя -> слова: по разделителям и по границам CamelCase."""
    parts: List[str] = []
    for chunk in SEPARATORS.split(str(text or "")):
        if not chunk:
            continue
        for word in CAMEL.split(chunk):
            word = word.strip()
            if word:
                parts.append(word)
    return parts


ENGLISH_SUFFIXES = ("ing", "ies", "es", "ed", "s")


@lru_cache(maxsize=20000)
def lemma(word: str) -> str:
    """Лемма одного слова. Для русского - pymorphy3, для латиницы - стемминг."""
    folded = fold(word)
    if not folded:
        return ""
    if HAS_CYRILLIC.search(folded):
        analyzer = _analyzer()
        if analyzer is None:
            return folded
        parses = analyzer.parse(folded)
        if not parses:
            return folded
        # Разборы pymorphy3 упорядочены по убыванию вероятности; берём первый,
        # иначе результат зависел бы от порядка словаря.
        return fold(parses[0].normal_form)
    if folded.endswith("ies") and len(folded) > 4:
        return folded[:-3] + "y"
    for suffix in ENGLISH_SUFFIXES:
        if folded.endswith(suffix) and len(folded) - len(suffix) >= 3:
            return folded[: -len(suffix)]
    return folded


def norm_name(text: str) -> str:
    """Нормализованное имя: леммы через пробел."""
    return " ".join(lemma(word) for word in split_words(text) if lemma(word))


def squash(norm: str) -> str:
    """Та же форма без пробелов - для метрик редакционного расстояния."""
    return norm.replace(" ", "")


class Synonyms:
    """Словарь синонимов задания (ТЗ п. 9).

    Каждая запись ``Клиент: [Заказчик, Покупатель]`` объявляет группу
    равнозначных имён. Внутри группы сходство имён считается равным 0.9 -
    не 1.0, чтобы точное совпадение всё же ценилось выше.
    """

    def __init__(self, mapping: Optional[Dict[str, Iterable[str]]] = None):
        self.groups: Dict[str, str] = {}
        for index, (key, values) in enumerate(sorted((mapping or {}).items())):
            group = f"g{index}"
            for raw in [key, *(values or [])]:
                name = norm_name(raw)
                if name:
                    self.groups.setdefault(name, group)

    def group(self, norm: str) -> Optional[str]:
        return self.groups.get(norm)

    def same(self, left: str, right: str) -> bool:
        a = self.group(left)
        return a is not None and a == self.group(right)

    def key(self, norm: str) -> str:
        """Ключ для сравнения множеств: группа синонимов, иначе само имя."""
        return self.group(norm) or norm


def canonical_pair(left: str, right: str) -> Tuple[str, str]:
    """Ненаправленные связи упорядочиваются лексикографически (ТЗ п. 3.2)."""
    return (left, right) if left <= right else (right, left)
