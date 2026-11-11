"""Метрики сходства имён и множеств (ТЗ п. 4.1).

Сходство имён: точное совпадение нормализованных форм - 1.0, совпадение по
словарю синонимов задания - 0.9, иначе лучшая из метрик Жаро-Винклера и
Левенштейна на леммах. Значение ниже порога ``name_min`` считается нулём:
случайное совпадение нескольких букв - не совпадение имён.
"""

from functools import lru_cache
from typing import Iterable, Optional, Set

from .normalize import Synonyms, squash


@lru_cache(maxsize=100000)
def jaro(left: str, right: str) -> float:
    if left == right:
        return 1.0
    if not left or not right:
        return 0.0
    len_left, len_right = len(left), len(right)
    window = max(len_left, len_right) // 2 - 1
    if window < 0:
        window = 0

    left_flags = [False] * len_left
    right_flags = [False] * len_right
    matches = 0
    for index, char in enumerate(left):
        start = max(0, index - window)
        end = min(index + window + 1, len_right)
        for other in range(start, end):
            if right_flags[other] or right[other] != char:
                continue
            left_flags[index] = True
            right_flags[other] = True
            matches += 1
            break
    if matches == 0:
        return 0.0

    transpositions = 0
    other = 0
    for index, flag in enumerate(left_flags):
        if not flag:
            continue
        while not right_flags[other]:
            other += 1
        if left[index] != right[other]:
            transpositions += 1
        other += 1
    transpositions //= 2

    return (
        matches / len_left + matches / len_right + (matches - transpositions) / matches
    ) / 3.0


def jaro_winkler(left: str, right: str, scaling: float = 0.1) -> float:
    score = jaro(left, right)
    if score <= 0.7:
        return score
    prefix = 0
    for first, second in zip(left, right):
        if first != second:
            break
        prefix += 1
        if prefix == 4:
            break
    return score + prefix * scaling * (1.0 - score)


@lru_cache(maxsize=100000)
def levenshtein(left: str, right: str) -> int:
    if left == right:
        return 0
    if not left:
        return len(right)
    if not right:
        return len(left)
    previous = list(range(len(right) + 1))
    for row, left_char in enumerate(left, start=1):
        current = [row]
        for column, right_char in enumerate(right, start=1):
            current.append(
                min(
                    previous[column] + 1,
                    current[column - 1] + 1,
                    previous[column - 1] + (left_char != right_char),
                )
            )
        previous = current
    return previous[-1]


def levenshtein_ratio(left: str, right: str) -> float:
    longest = max(len(left), len(right))
    if longest == 0:
        return 1.0
    return 1.0 - levenshtein(left, right) / longest


def name_similarity(
    left_norm: str,
    right_norm: str,
    synonyms: Optional[Synonyms] = None,
    name_min: float = 0.6,
) -> float:
    """Сходство двух нормализованных имён в [0, 1]."""
    if not left_norm and not right_norm:
        return 1.0
    if not left_norm or not right_norm:
        return 0.0
    if left_norm == right_norm:
        return 1.0
    if synonyms is not None and synonyms.same(left_norm, right_norm):
        return 0.9
    left, right = squash(left_norm), squash(right_norm)
    score = max(jaro_winkler(left, right), levenshtein_ratio(left, right))
    return score if score >= name_min else 0.0


def synonym_keys(
    names: Iterable[str], synonyms: Optional[Synonyms] = None
) -> Set[str]:
    """Множество имён, в котором синонимы склеены в один ключ."""
    if synonyms is None:
        return {name for name in names if name}
    return {synonyms.key(name) for name in names if name}


def jaccard(left: Set[str], right: Set[str]) -> float:
    if not left and not right:
        return 1.0
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)
