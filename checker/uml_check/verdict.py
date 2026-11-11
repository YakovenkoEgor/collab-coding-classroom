"""Вердикт (ТЗ п. 6).

Вердикт - не оценка в баллах, а одно из трёх: accepted / rejected /
needs_review. Каждая причина несёт машинный код и пояснение (ТЗ п. 11).
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .config import Config
from .metrics import Analysis

ACCEPTED = "accepted"
REJECTED = "rejected"
NEEDS_REVIEW = "needs_review"

FLAG_MESSAGES = {
    "possible_merge": "похоже, несколько сущностей эталона объединены в один класс",
    "possible_split": "похоже, одна сущность эталона разбита на несколько классов",
    "possible_absorption": "похоже, атрибуты одной сущности перенесены в другой класс",
}


@dataclass
class Verdict:
    verdict: str
    reasons: List[str] = field(default_factory=list)
    details: List[Dict[str, str]] = field(default_factory=list)

    def add(self, code: str, message: str) -> None:
        if code not in self.reasons:
            self.reasons.append(code)
            self.details.append({"code": code, "message": message})


def gate_failure(code: str, message: str) -> Verdict:
    """C0 не пройден: ошибка разбора не доказывает ошибку студента (ТЗ п. 2.2)."""
    result = Verdict(NEEDS_REVIEW)
    result.add(code, message)
    return result


def decide(
    best: Analysis,
    ranked: List[Tuple[str, float]],
    config: Config,
    ref_class_count: int,
) -> Verdict:
    score = best.score
    result = Verdict(NEEDS_REVIEW)

    # --- правила 2-5 -------------------------------------------------------
    missing_required = bool(
        best.missing_required_classes or best.missing_required_relations
    )
    if missing_required:
        below = score < config.accept
        result.verdict = REJECTED if below else NEEDS_REVIEW
        for name in best.missing_required_classes:
            result.add(
                "missing_required_class",
                f"обязательный класс «{name}» не найден",
            )
        for pair in best.missing_required_relations:
            result.add(
                "missing_required_relation",
                f"обязательная связь «{pair[0]}» - «{pair[1]}» не найдена",
            )
        if not below:
            result.add(
                "required_missing_but_score_high",
                "обязательные элементы не найдены, но сходство высокое - нужен человек",
            )
    elif score >= config.accept:
        result.verdict = ACCEPTED
        result.add(
            "score_above_accept",
            f"сходство {score:.2f} не ниже порога {config.accept:.2f}",
        )
    elif score < config.reject:
        result.verdict = REJECTED
        result.add(
            "score_below_reject",
            f"сходство {score:.2f} ниже порога {config.reject:.2f}",
        )
    else:
        result.add(
            "score_between_thresholds",
            f"сходство {score:.2f} между порогами "
            f"{config.reject:.2f} и {config.accept:.2f}",
        )

    # --- правило 6 ---------------------------------------------------------
    # Эти условия означают "автомат не уверен", поэтому они снимают accepted.
    # Уже вынесенный rejected они не отменяют: низкое сходство остаётся низким
    # (ТЗ п. 7.4 - флаги блокируют именно accepted).
    blockers: List[Tuple[str, str]] = []

    c1 = best.scores.get("c1", 0.0)
    c3 = best.scores.get("c3", 0.0)
    if c1 >= 0.9 and c3 < 0.4:
        blockers.append(
            (
                "metric_contradiction",
                f"классы почти все на месте (C1 = {c1:.2f}), "
                f"а структура связей не совпадает (C3 = {c3:.2f})",
            )
        )

    for flag in best.flags:
        code = flag.split(":", 1)[0]
        blockers.append(
            (code, FLAG_MESSAGES.get(code, "подозрение на структурное преобразование"))
        )

    if ref_class_count > 0:
        limit = config.extra_classes_max * ref_class_count
        extra = len(best.classes.extra) if best.classes else 0
        if extra > limit:
            blockers.append(
                (
                    "too_many_extra_classes",
                    f"лишних классов {extra}, допустимо не больше {limit:.1f}",
                )
            )

    for code, message in blockers:
        if result.verdict == ACCEPTED:
            result.verdict = NEEDS_REVIEW
        result.add(code, message)

    # Разрыв между двумя лучшими эталонами при разных вердиктах по ним:
    # выбор лучшего эталона тогда случаен, и вердикт вместе с ним.
    if len(ranked) >= 2:
        first, second = ranked[0][1], ranked[1][1]
        if first - second < config.ref_gap_min and _verdict_by_score(
            first, config
        ) != _verdict_by_score(second, config):
            result.verdict = NEEDS_REVIEW
            result.add(
                "close_references",
                f"два эталона почти равны ({first:.2f} и {second:.2f}), "
                "а вердикты по ним разные",
            )

    return result


def _verdict_by_score(score: float, config: Config) -> str:
    if score >= config.accept:
        return ACCEPTED
    if score < config.reject:
        return REJECTED
    return NEEDS_REVIEW
