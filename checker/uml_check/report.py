"""Отчёты (ТЗ п. 8).

Три представления одного и того же результата:
  * ``data``             - JSON по схеме п. 8, для платформы и для анализа;
  * ``markdown``         - для преподавателя, со всеми числами;
  * ``student_markdown`` - для студента: что и где не совпало, без эталона и
                           без терминологии метрик (ТЗ п. 8, последний абзац).
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .config import Config
from .metrics import Analysis, RELATION_LABELS
from .model import Diagram
from .verdict import ACCEPTED, NEEDS_REVIEW, REJECTED, Verdict
from .version import PARSER_VERSION, TOOL_VERSION

VERDICT_TITLES = {
    ACCEPTED: "принято",
    REJECTED: "не принято",
    NEEDS_REVIEW: "отправлено преподавателю",
}

PROBLEM_WORDS = {
    "kind": "другой тип связи",
    "direction": "другое направление",
    "multiplicity": "другие кратности",
    "inversion": "перевёрнутые концы связи",
}

KIND_WORDS = {
    "class": "класс",
    "abstract": "абстрактный класс",
    "interface": "интерфейс",
    "enum": "перечисление",
}


def _round(value: Any) -> Any:
    """Числа округляются до шести знаков: два прогона должны дать одни байты."""
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, dict):
        return {key: _round(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_round(item) for item in value]
    return value


@dataclass
class Report:
    data: Dict[str, Any] = field(default_factory=dict)
    markdown: str = ""
    student_markdown: str = ""

    @property
    def verdict(self) -> str:
        return str(self.data.get("verdict", NEEDS_REVIEW))

    @property
    def score(self) -> Optional[float]:
        return self.data.get("score")


def build(
    verdict: Verdict,
    best: Optional[Analysis],
    ranked: List[Tuple[str, float]],
    student: Optional[Diagram],
    refs: Dict[str, Diagram],
    config: Config,
    config_hash: str,
    extra_warnings: Optional[List[str]] = None,
) -> Report:
    warnings = list(extra_warnings or [])
    if student is not None:
        warnings.extend(student.warnings)
    if best is not None:
        warnings.extend(best.warnings)

    data: Dict[str, Any] = {
        "verdict": verdict.verdict,
        "reasons": list(verdict.reasons),
        "reason_details": list(verdict.details),
        "best_reference": best.ref_id if best is not None else None,
        "score": _round(best.score) if best is not None else None,
        "criteria": _round(best.criteria) if best is not None else {},
        "all_refs": {ref_id: _round(score) for ref_id, score in ranked},
        "flags": list(best.flags) if best is not None else [],
        "warnings": sorted(set(warnings)),
        "meta": {
            "task_id": config.task_id,
            "config_hash": config_hash,
            "parser_version": PARSER_VERSION,
            "tool_version": TOOL_VERSION,
        },
    }
    if best is not None:
        data["required"] = {
            "missing_classes": list(best.missing_required_classes),
            "missing_relations": [list(pair) for pair in best.missing_required_relations],
        }

    report = Report(data=data)
    report.markdown = _teacher_markdown(data, best, student, refs, config)
    report.student_markdown = _student_markdown(data, best, student, refs, config)
    return report


# --- отчёт преподавателю ---------------------------------------------------


def _teacher_markdown(
    data: Dict[str, Any],
    best: Optional[Analysis],
    student: Optional[Diagram],
    refs: Dict[str, Diagram],
    config: Config,
) -> str:
    lines: List[str] = []
    title = VERDICT_TITLES.get(data["verdict"], data["verdict"])
    lines.append(f"# Автопроверка диаграммы: {title}")
    lines.append("")

    if data["score"] is not None:
        lines.append(
            f"Сходство с лучшим эталоном (**{data['best_reference']}**): "
            f"**{data['score']:.3f}** "
            f"(порог принятия {config.accept:.2f}, отклонения {config.reject:.2f})"
        )
        lines.append("")

    if data["reason_details"]:
        lines.append("## Почему такой вердикт")
        for detail in data["reason_details"]:
            lines.append(f"- `{detail['code']}` — {detail['message']}")
        lines.append("")

    if data["all_refs"]:
        lines.append("## Сходство по эталонам")
        for ref_id, score in sorted(
            data["all_refs"].items(), key=lambda item: (-item[1], item[0])
        ):
            mark = " ← лучший" if ref_id == data["best_reference"] else ""
            lines.append(f"- {ref_id}: {score:.3f}{mark}")
        lines.append("")

    criteria = data.get("criteria") or {}
    if criteria:
        lines.append("## Критерии")
        lines.append("")
        lines.append("| Критерий | Значение | Вес |")
        lines.append("|---|---|---|")
        rows = [
            ("C1. Классы", "C1_classes", config.weights["c1"]),
            ("C2. Атрибуты", "C2_attributes", config.weights["c2"] * (1 - config.method_weight)),
            ("C2m. Методы", "C2m_methods", config.weights["c2"] * config.method_weight),
            ("C3. Связи", "C3_relations", config.weights["c3"]),
            ("C4. Типы и кратности", "C4_semantics", config.weights["c4"]),
            ("C5. Структура", "C5_structure", config.weights["c5"]),
        ]
        for label, key, weight in rows:
            section = criteria.get(key) or {}
            score = section.get("score")
            value = "—" if score is None else f"{score:.3f}"
            lines.append(f"| {label} | {value} | {weight:.2f} |")
        lines.append("")

    classes = criteria.get("C1_classes") or {}
    if classes.get("missing") or classes.get("extra"):
        lines.append("### Классы")
        for name in classes.get("missing", []):
            lines.append(f"- не найден класс эталона: **{name}**")
        for name in classes.get("extra", []):
            lines.append(f"- лишний класс у студента: **{name}**")
        lines.append("")
    for mismatch in classes.get("kind_mismatches", []):
        lines.append(
            f"- «{mismatch['student']}»: ожидался "
            f"{KIND_WORDS.get(mismatch['expected'], mismatch['expected'])}, "
            f"получен {KIND_WORDS.get(mismatch['got'], mismatch['got'])}"
        )
    for renamed in classes.get("renamed", []):
        lines.append(
            f"- «{renamed['student']}» сопоставлен с «{renamed['ref']}» "
            "по содержимому и связям, но назван иначе"
        )
    if classes.get("kind_mismatches") or classes.get("renamed"):
        lines.append("")

    attributes = criteria.get("C2_attributes") or {}
    if attributes.get("per_class"):
        lines.append("### Атрибуты и методы по классам")
        for class_name, detail in sorted(attributes["per_class"].items()):
            parts = []
            if detail.get("missing"):
                parts.append("не хватает: " + ", ".join(detail["missing"]))
            if detail.get("extra"):
                parts.append("лишние: " + ", ".join(detail["extra"]))
            if detail.get("missing_methods"):
                parts.append("нет методов: " + ", ".join(detail["missing_methods"]))
            if detail.get("extra_methods"):
                parts.append("лишние методы: " + ", ".join(detail["extra_methods"]))
            lines.append(f"- **{class_name}** — " + "; ".join(parts))
        lines.append("")

    relations = criteria.get("C3_relations") or {}
    if any(
        relations.get(key) for key in ("partial", "missing", "extra")
    ):
        lines.append("### Связи")
        lines.append(f"- полных совпадений: {relations.get('exact', 0)}")
        for item in relations.get("partial", []):
            problems = ", ".join(
                PROBLEM_WORDS.get(problem, problem) for problem in item.get("problems", [])
            )
            lines.append(
                f"- частично: `{item['student']}` против `{item['ref']}` ({problems})"
            )
        for text in relations.get("missing", []):
            lines.append(f"- нет связи эталона: `{text}`")
        for text in relations.get("extra", []):
            lines.append(f"- лишняя связь: `{text}`")
        lines.append("")

    semantics = criteria.get("C4_semantics") or {}
    if semantics.get("mismatches"):
        lines.append("### Типы и кратности")
        for item in semantics["mismatches"]:
            expected = RELATION_LABELS.get(item["expected"], item["expected"])
            got = RELATION_LABELS.get(item["got"], item["got"])
            parts = []
            if item["expected"] != item["got"]:
                parts.append(f"ожидалась {expected}, получена {got}")
            if "expected_multiplicity" in item:
                parts.append(
                    "кратности ожидались "
                    + _multiplicity_text(item["expected_multiplicity"])
                    + ", получены "
                    + _multiplicity_text(item["got_multiplicity"])
                )
            lines.append(f"- `{item['relation']}`: " + "; ".join(parts))
        lines.append("")

    structure = criteria.get("C5_structure") or {}
    if structure:
        lines.append(
            f"### Структура\n\n- расстояние редактирования графа: "
            f"{structure.get('ged')} из {structure.get('ged_max')}\n"
        )

    if data["flags"]:
        lines.append("### Флаги")
        for flag in data["flags"]:
            lines.append(f"- `{flag}`")
        lines.append("")

    if data["warnings"]:
        lines.append("### Предупреждения разбора")
        for warning in data["warnings"]:
            lines.append(f"- {warning}")
        lines.append("")

    meta = data["meta"]
    lines.append(
        f"<sub>инструмент {meta['tool_version']}, парсер {meta['parser_version']}, "
        f"конфигурация {meta['config_hash'][:12]}</sub>"
    )
    return "\n".join(lines).strip() + "\n"


# --- отчёт студенту --------------------------------------------------------


def _anchor(ref_ident: str, best: Analysis, student: Diagram, ref: Diagram) -> Optional[str]:
    """Чей-то знакомый студенту класс рядом с пропущенным классом эталона.

    Имя эталонного класса студенту не показывается, поэтому пропуск
    описывается через соседа, который у студента есть.
    """
    for relation in ref.relations:
        other = None
        if relation.source == ref_ident:
            other = relation.target
        elif relation.target == ref_ident:
            other = relation.source
        if other is None:
            continue
        paired = best.classes.by_ref.get(other) if best.classes else None
        if paired is not None:
            return student.classes[paired].name
    return None


def _student_markdown(
    data: Dict[str, Any],
    best: Optional[Analysis],
    student: Optional[Diagram],
    refs: Dict[str, Diagram],
    config: Config,
) -> str:
    verdict = data["verdict"]
    lines: List[str] = []
    if verdict == ACCEPTED:
        lines.append("**Диаграмма принята автоматической проверкой.**")
    elif verdict == REJECTED:
        lines.append("**Диаграмма не принята автоматической проверкой.**")
    else:
        lines.append(
            "**Диаграмма отправлена преподавателю** — автоматическая проверка "
            "не смогла решить сама."
        )
    lines.append("")

    notes: List[str] = []

    if "parse_error" in data["reasons"]:
        for detail in data["reason_details"]:
            if detail["code"] == "parse_error":
                notes.append(detail["message"])
    if "unsupported_diagram" in data["reasons"]:
        notes.append(
            "Проверяются только диаграммы классов — похоже, это диаграмма другого вида."
        )

    if best is not None and student is not None:
        ref = refs.get(best.ref_id)
        classes = best.criteria.get("C1_classes") or {}
        relations = best.criteria.get("C3_relations") or {}
        attributes = best.criteria.get("C2_attributes") or {}

        if best.classes is not None and ref is not None:
            for ref_ident in best.classes.missing:
                anchor = _anchor(ref_ident, best, student, ref)
                if anchor:
                    notes.append(
                        f"Кажется, не хватает класса, связанного с «{anchor}»."
                    )
                else:
                    notes.append("Кажется, в диаграмме не хватает одного из классов.")

        for name in classes.get("extra", []):
            notes.append(f"Класс «{name}» в решении лишний или ни с чем не связан.")

        for renamed in classes.get("renamed", []):
            notes.append(
                f"Класс «{renamed['student']}» по содержанию похож на нужный, "
                "но назван не так, как ожидается в задании."
            )

        for mismatch in classes.get("kind_mismatches", []):
            notes.append(
                f"У «{mismatch['student']}» должен быть другой вид: не "
                f"{KIND_WORDS.get(mismatch['got'], mismatch['got'])}, а "
                f"{KIND_WORDS.get(mismatch['expected'], mismatch['expected'])}."
            )

        for item in relations.get("partial", []):
            problems = item.get("problems") or []
            ends = _relation_ends(item["student"])
            if "inversion" in problems:
                notes.append(f"У связи {ends} перевёрнуто направление.")
            elif "kind" in problems:
                notes.append(f"У связи {ends} другой тип связи.")
            elif "multiplicity" in problems:
                notes.append(f"У связи {ends} не те кратности.")
            else:
                notes.append(f"Связь {ends} не совпала с ожидаемой.")

        for text in relations.get("extra", []):
            notes.append(f"Связь {_relation_ends(text)} лишняя.")

        missing_relations = relations.get("missing", [])
        if missing_relations:
            notes.append(
                "Не хватает связей между классами: "
                f"{len(missing_relations)} шт."
                if len(missing_relations) > 1
                else "Не хватает одной связи между классами."
            )

        for class_name in sorted((attributes.get("per_class") or {})):
            detail = attributes["per_class"][class_name]
            if detail.get("missing"):
                notes.append(
                    f"В классе «{class_name}» перечислены не все нужные атрибуты."
                )
            if detail.get("extra"):
                notes.append(
                    f"В классе «{class_name}» есть атрибуты, которых в задании нет."
                )
            if detail.get("missing_methods"):
                notes.append(f"В классе «{class_name}» не хватает методов.")

        for flag in data["flags"]:
            code, _, payload = flag.partition(":")
            target = payload.split("->")[-1].strip()
            if code == "possible_merge":
                notes.append(
                    f"Похоже, в классе «{target}» объединено то, что стоит разделить."
                )
            elif code == "possible_split":
                notes.append(
                    "Похоже, одна сущность разбита на несколько классов."
                )
            elif code == "possible_absorption":
                notes.append(
                    f"Похоже, в класс «{target}» перенесены атрибуты другой сущности."
                )

    if notes:
        lines.append("Что стоит посмотреть:")
        lines.append("")
        seen = set()
        for note in notes:
            if note in seen:
                continue
            seen.add(note)
            lines.append(f"- {note}")
    elif verdict == ACCEPTED:
        lines.append("Замечаний нет.")

    if student is not None and student.warnings:
        lines.append("")
        lines.append("Строки, которые проверка не поняла и пропустила:")
        lines.append("")
        for warning in sorted(set(student.warnings)):
            lines.append(f"- {warning}")

    return "\n".join(lines).strip() + "\n"


def _multiplicity_text(ends: List[Optional[str]]) -> str:
    """`[None, '0..*']` -> `не указана … 0..*`."""
    return " … ".join(end if end else "не указана" for end in ends)


def _relation_ends(text: str) -> str:
    """`Клиент *-- Счёт` -> `«Клиент» - «Счёт»`: тип связи студенту не называем."""
    for symbol in ("--|>", "..|>", "*--", "o--", "..>", "-->", "--"):
        if f" {symbol} " in text:
            left, _, right = text.partition(f" {symbol} ")
            return f"«{left.strip()}» - «{right.strip()}»"
    return text
