"""Метрики C1-C5 и флаги слепых зон (ТЗ п. 5 и п. 7).

Все метрики считаются на уже найденном назначении (см. matching.py), поэтому
полиномиальны: ни одна из них не перебирает соответствия заново.
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from .config import Config
from .matching import (
    ClassMatching,
    MemberMatching,
    RelationMatching,
    match_classes,
    match_members,
    match_relations,
    multiplicity_score,
)
from .model import Diagram, Relation

RELATION_SYMBOLS = {
    "generalization": "--|>",
    "realization": "..|>",
    "composition": "*--",
    "aggregation": "o--",
    "association": "-->",
    "dependency": "..>",
}

RELATION_LABELS = {
    "generalization": "наследование",
    "realization": "реализация интерфейса",
    "composition": "композиция",
    "aggregation": "агрегация",
    "association": "ассоциация",
    "dependency": "зависимость",
}


def f1(matched: float, student_total: float, ref_total: float) -> Tuple[float, float, float]:
    """F1 вместе с точностью и полнотой; пустое против пустого - это 1.0."""
    if student_total == 0 and ref_total == 0:
        return 1.0, 1.0, 1.0
    precision = matched / student_total if student_total else 0.0
    recall = matched / ref_total if ref_total else 0.0
    if precision + recall == 0:
        return 0.0, precision, recall
    return 2 * precision * recall / (precision + recall), precision, recall


def relation_text(diagram: Diagram, relation: Relation) -> str:
    source = diagram.classes.get(relation.source)
    target = diagram.classes.get(relation.target)
    symbol = RELATION_SYMBOLS.get(relation.kind, "--")
    if relation.kind == "association" and not relation.directed:
        symbol = "--"
    return (
        f"{source.name if source else relation.source} "
        f"{symbol} "
        f"{target.name if target else relation.target}"
    )


@dataclass
class Analysis:
    """Результат сравнения студенческой диаграммы с одним эталоном."""

    ref_id: str
    score: float = 0.0
    # Среднее сходство сопоставленных пар классов. В итоговый счёт не входит:
    # служит вторым ключом при выборе лучшего эталона, когда счёт одинаков
    # (например, эталоны отличаются только синонимами имён).
    match_quality: float = 0.0
    criteria: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    scores: Dict[str, float] = field(default_factory=dict)
    flags: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)
    classes: Optional[ClassMatching] = None
    relations: Optional[RelationMatching] = None
    members: Dict[str, Tuple[MemberMatching, MemberMatching]] = field(
        default_factory=dict
    )
    missing_required_classes: List[str] = field(default_factory=list)
    missing_required_relations: List[List[str]] = field(default_factory=list)


def analyse(
    student: Diagram, ref: Diagram, ref_id: str, config: Config
) -> Analysis:
    analysis = Analysis(ref_id=ref_id)
    classes = match_classes(student, ref, config)
    relations = match_relations(student, ref, classes, config)
    analysis.classes = classes
    analysis.relations = relations

    _criterion_classes(analysis, student, ref, config)
    _criterion_members(analysis, student, ref, config)
    _criterion_relations(analysis, student, ref, config)
    _criterion_semantics(analysis, student, ref, config)
    _criterion_structure(analysis, student, ref, config)
    _flags(analysis, student, ref, config)
    _required(analysis, student, ref, config)

    pairs = analysis.classes.pairs if analysis.classes else []
    analysis.match_quality = (
        sum(pair.sim for pair in pairs) / len(pairs) if pairs else 0.0
    )

    weights = config.weights
    analysis.score = sum(
        weights[key] * analysis.scores[key] for key in ("c1", "c2", "c3", "c4", "c5")
    )
    return analysis


# --- C1 --------------------------------------------------------------------


def _criterion_classes(
    analysis: Analysis, student: Diagram, ref: Diagram, config: Config
) -> None:
    classes = analysis.classes
    matched = len(classes.pairs)
    score, precision, recall = f1(matched, len(student.classes), len(ref.classes))
    kind_mismatches = [
        {
            "student": student.classes[pair.student].name,
            "ref": ref.classes[pair.ref].name,
            "expected": ref.classes[pair.ref].kind,
            "got": student.classes[pair.student].kind,
        }
        for pair in classes.pairs
        if student.classes[pair.student].kind != ref.classes[pair.ref].kind
    ]
    # Переименование - известная слепая зона метрик (ТЗ п. 7): класс
    # сопоставляется по содержимому и окрестности, и счёт от неверного имени
    # не страдает. Поэтому такие пары отмечаются отдельно и учитываются в C5
    # как замена узла.
    renamed = [
        {
            "student": student.classes[pair.student].name,
            "ref": ref.classes[pair.ref].name,
        }
        for pair in classes.pairs
        if pair.name_sim <= 0.0
    ]

    analysis.scores["c1"] = score
    analysis.criteria["C1_classes"] = {
        "score": score,
        "precision": precision,
        "recall": recall,
        "matched": matched,
        "extra": [student.classes[ident].name for ident in classes.extra],
        "missing": [ref.classes[ident].name for ident in classes.missing],
        "kind_mismatches": kind_mismatches,
        "renamed": renamed,
        "pairs": [
            {
                "student": student.classes[pair.student].name,
                "ref": ref.classes[pair.ref].name,
                "sim": pair.sim,
            }
            for pair in classes.pairs
        ],
    }


# --- C2 --------------------------------------------------------------------


def _criterion_members(
    analysis: Analysis, student: Diagram, ref: Diagram, config: Config
) -> None:
    attr_matched = attr_student = attr_ref = 0
    method_matched = method_student = method_ref = 0
    per_class: Dict[str, Dict[str, List[str]]] = {}

    for pair in analysis.classes.pairs:
        student_class = student.classes[pair.student]
        ref_class = ref.classes[pair.ref]
        attributes = match_members(
            student_class.attributes, ref_class.attributes, config
        )
        methods = match_members(student_class.methods, ref_class.methods, config)
        analysis.members[pair.student] = (attributes, methods)

        attr_matched += len(attributes.matched)
        attr_student += len(student_class.attributes)
        attr_ref += len(ref_class.attributes)
        method_matched += len(methods.matched)
        method_student += len(student_class.methods)
        method_ref += len(ref_class.methods)

        # Видимость и типы данных в метрики не входят (ТЗ п. 3.4): при
        # включённом флаге расхождения по ним попадают в предупреждения, и
        # преподаватель решает сам, считать ли это ошибкой.
        if config.check_types or config.check_visibility:
            _member_warnings(analysis, student_class, ref_class, attributes, config)

        if attributes.missing or attributes.extra or methods.missing or methods.extra:
            per_class[student_class.name] = {
                "missing": attributes.missing,
                "extra": attributes.extra,
                "missing_methods": methods.missing,
                "extra_methods": methods.extra,
            }

    attr_score, attr_precision, attr_recall = f1(attr_matched, attr_student, attr_ref)
    method_score, _, _ = f1(method_matched, method_student, method_ref)
    weight = config.method_weight
    combined = (1.0 - weight) * attr_score + weight * method_score

    analysis.scores["c2"] = combined
    analysis.criteria["C2_attributes"] = {
        "score": attr_score,
        "precision": attr_precision,
        "recall": attr_recall,
        "matched": attr_matched,
        "per_class": per_class,
    }
    analysis.criteria["C2m_methods"] = {
        "score": method_score,
        "matched": method_matched,
        "weight": weight,
    }


def _member_warnings(
    analysis: Analysis,
    student_class,
    ref_class,
    attributes: MemberMatching,
    config: Config,
) -> None:
    by_name = {member.name: member for member in student_class.attributes}
    ref_by_name = {member.name: member for member in ref_class.attributes}
    for student_name, ref_name in attributes.matched:
        student_member = by_name.get(student_name)
        ref_member = ref_by_name.get(ref_name)
        if student_member is None or ref_member is None:
            continue
        if (
            config.check_types
            and (student_member.type or "").strip().casefold()
            != (ref_member.type or "").strip().casefold()
        ):
            analysis.warnings.append(
                f"type_mismatch: «{student_class.name}.{student_name}» объявлен как "
                f"{student_member.type or 'без типа'}, ожидался "
                f"{ref_member.type or 'без типа'}"
            )
        if (
            config.check_visibility
            and (student_member.visibility or "") != (ref_member.visibility or "")
        ):
            analysis.warnings.append(
                f"visibility_mismatch: у «{student_class.name}.{student_name}» "
                f"видимость {student_member.visibility or 'не указана'}, ожидалась "
                f"{ref_member.visibility or 'не указана'}"
            )


# --- C3 --------------------------------------------------------------------


def _criterion_relations(
    analysis: Analysis, student: Diagram, ref: Diagram, config: Config
) -> None:
    relations = analysis.relations
    credit = sum(match.credit for match in relations.matches)
    score, precision, recall = f1(
        credit, len(student.relations), len(ref.relations)
    )

    partial = [
        {
            "student": relation_text(student, student.relations[match.student_index]),
            "ref": relation_text(ref, ref.relations[match.ref_index]),
            "problem": match.problems[0] if match.problems else "partial",
            "problems": match.problems,
        }
        for match in relations.matches
        if match.verdict != "exact"
    ]

    analysis.scores["c3"] = score
    analysis.criteria["C3_relations"] = {
        "score": score,
        "precision": precision,
        "recall": recall,
        "exact": sum(1 for match in relations.matches if match.verdict == "exact"),
        "partial": partial,
        "missing": [
            relation_text(ref, ref.relations[index]) for index in relations.missing
        ],
        "extra": [
            relation_text(student, student.relations[index])
            for index in relations.extra
        ],
    }

    for ref_index, middle in relations.transitive:
        analysis.warnings.append(
            "extra_intermediate: связь «"
            + relation_text(ref, ref.relations[ref_index])
            + f"» проведена через лишний класс «{student.classes[middle].name}»"
        )


# --- C4 --------------------------------------------------------------------


def _criterion_semantics(
    analysis: Analysis, student: Diagram, ref: Diagram, config: Config
) -> None:
    relations = analysis.relations
    mismatches = []
    scores = []
    for match in relations.matches:
        student_relation = student.relations[match.student_index]
        ref_relation = ref.relations[match.ref_index]
        kind_score = 1.0 if student_relation.kind == ref_relation.kind else 0.0
        mult = multiplicity_score(
            student_relation,
            ref_relation,
            config,
            swapped=match.verdict == "inversion",
        )
        scores.append((kind_score + mult) / 2.0)
        if kind_score < 1.0 or mult < 1.0:
            entry = {
                "relation": relation_text(student, student_relation),
                "expected": ref_relation.kind,
                "got": student_relation.kind,
            }
            if mult < 1.0:
                entry["expected_multiplicity"] = [
                    ref_relation.src_mult,
                    ref_relation.tgt_mult,
                ]
                entry["got_multiplicity"] = [
                    student_relation.src_mult,
                    student_relation.tgt_mult,
                ]
            mismatches.append(entry)

    if scores:
        score = sum(scores) / len(scores)
    elif not student.relations and not ref.relations:
        score = 1.0
    else:
        score = 0.0

    analysis.scores["c4"] = score
    analysis.criteria["C4_semantics"] = {"score": score, "mismatches": mismatches}


# --- C5 --------------------------------------------------------------------


def _criterion_structure(
    analysis: Analysis, student: Diagram, ref: Diagram, config: Config
) -> None:
    classes = analysis.classes
    relations = analysis.relations

    node_edits = len(classes.extra) + len(classes.missing)
    # Замена узла: класс сопоставлен, но назван не тем именем или объявлен не
    # тем видом.
    node_edits += sum(
        1
        for pair in classes.pairs
        if student.classes[pair.student].kind != ref.classes[pair.ref].kind
        or pair.name_sim <= 0.0
    )
    edge_edits = len(relations.extra) + len(relations.missing)
    edge_edits += sum(1 for match in relations.matches if match.verdict != "exact")

    ged = node_edits + edge_edits
    ged_max = (
        len(student.classes)
        + len(ref.classes)
        + len(student.relations)
        + len(ref.relations)
    )
    score = 1.0 if ged_max == 0 else max(0.0, 1.0 - ged / ged_max)

    analysis.scores["c5"] = score
    analysis.criteria["C5_structure"] = {
        "score": score,
        "ged": ged,
        "ged_max": ged_max,
    }


# --- флаги слепых зон (ТЗ п. 7) --------------------------------------------


def _flags(analysis: Analysis, student: Diagram, ref: Diagram, config: Config) -> None:
    classes = analysis.classes
    threshold = config.thresholds.get("merge_min", 0.5)
    absorb_min = config.thresholds.get("absorb_min", 0.5)

    # Слияние: один класс студента похож по содержимому сразу на несколько
    # эталонных. Расщепление - обратное.
    for student_ident in sorted(student.classes):
        close = sorted(
            ref_ident
            for ref_ident in ref.classes
            if classes.attr_sims.get((student_ident, ref_ident), 0.0) >= threshold
        )
        if len(close) >= 2:
            analysis.flags.append(
                "possible_merge:"
                + "+".join(ref.classes[ident].name for ident in close)
                + f" -> {student.classes[student_ident].name}"
            )

    for ref_ident in sorted(ref.classes):
        close = sorted(
            student_ident
            for student_ident in student.classes
            if classes.attr_sims.get((student_ident, ref_ident), 0.0) >= threshold
        )
        if len(close) >= 2:
            analysis.flags.append(
                "possible_split:"
                + f"{ref.classes[ref_ident].name} -> "
                + "+".join(student.classes[ident].name for ident in close)
            )

    # Поглощение: атрибуты эталонного класса нашлись в классе студента,
    # сопоставленном другому эталонному классу.
    for ref_ident in sorted(ref.classes):
        ref_attributes = {
            config.synonyms.key(member.norm)
            for member in ref.classes[ref_ident].attributes
            if member.norm
        }
        if not ref_attributes:
            continue
        for student_ident in sorted(student.classes):
            paired = classes.by_student.get(student_ident)
            if paired is None or paired == ref_ident:
                continue
            student_attributes = {
                config.synonyms.key(member.norm)
                for member in student.classes[student_ident].attributes
                if member.norm
            }
            if not student_attributes:
                continue
            share = len(ref_attributes & student_attributes) / len(ref_attributes)
            if share >= absorb_min:
                analysis.flags.append(
                    "possible_absorption:"
                    f"{ref.classes[ref_ident].name} -> "
                    f"{student.classes[student_ident].name}"
                )

    analysis.flags = sorted(set(analysis.flags))


# --- обязательные элементы (ТЗ п. 6.2) -------------------------------------


def _required(
    analysis: Analysis, student: Diagram, ref: Diagram, config: Config
) -> None:
    from .normalize import norm_name
    from .similarity import name_similarity

    student_norms = [klass.norm for klass in student.classes.values()]

    def present(name: str) -> bool:
        wanted = norm_name(name)
        return any(
            name_similarity(wanted, norm, config.synonyms, config.name_min) >= 0.9
            for norm in student_norms
        )

    analysis.missing_required_classes = [
        name for name in config.required_classes if not present(name)
    ]

    def ident_for(name: str) -> Optional[str]:
        wanted = norm_name(name)
        best, best_sim = None, 0.0
        for ident, klass in sorted(student.classes.items()):
            sim = name_similarity(wanted, klass.norm, config.synonyms, config.name_min)
            if sim >= 0.9 and sim > best_sim:
                best, best_sim = ident, sim
        return best

    missing_relations = []
    for pair in config.required_relations:
        left, right = ident_for(pair[0]), ident_for(pair[1])
        if left is None or right is None:
            missing_relations.append(list(pair))
            continue
        connected = any(
            {relation.source, relation.target} == {left, right}
            for relation in student.relations
        )
        if not connected:
            missing_relations.append(list(pair))
    analysis.missing_required_relations = missing_relations
