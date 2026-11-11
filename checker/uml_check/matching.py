"""Сопоставление элементов студенческой диаграммы с эталоном (ТЗ п. 4).

Сопоставление не зависит от порядка записи и устойчиво к переименованию:
между элементами считается матрица стоимости, оптимальное назначение ищет
венгерский алгоритм (scipy.optimize.linear_sum_assignment).
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Set, Tuple

from .config import Config
from .model import Diagram, Klass, Member, Relation
from .similarity import jaccard, name_similarity, synonym_keys

UNMATCHED_COST = 1.0


def assign(cost: Sequence[Sequence[float]]) -> List[Tuple[int, int]]:
    """Венгерский алгоритм на прямоугольной матрице стоимости.

    Матрица дополняется до квадратной стоимостью 1.0 (стоимость "ни с чем не
    сопоставлено"), поэтому лишние строки и столбцы просто остаются без пары.
    """
    rows = len(cost)
    columns = len(cost[0]) if rows else 0
    if rows == 0 or columns == 0:
        return []

    import numpy as np
    from scipy.optimize import linear_sum_assignment

    size = max(rows, columns)
    matrix = np.full((size, size), UNMATCHED_COST, dtype=float)
    for row in range(rows):
        for column in range(columns):
            matrix[row][column] = cost[row][column]
    row_indices, column_indices = linear_sum_assignment(matrix)
    return [
        (int(row), int(column))
        for row, column in zip(row_indices, column_indices)
        if row < rows and column < columns
    ]


# --- классы ----------------------------------------------------------------


@dataclass
class ClassMatch:
    student: str
    ref: str
    sim: float
    name_sim: float
    attr_sim: float
    ctx_sim: float


@dataclass
class ClassMatching:
    pairs: List[ClassMatch] = field(default_factory=list)
    by_student: Dict[str, str] = field(default_factory=dict)
    by_ref: Dict[str, str] = field(default_factory=dict)
    extra: List[str] = field(default_factory=list)  # классы студента без пары
    missing: List[str] = field(default_factory=list)  # классы эталона без пары
    attr_sims: Dict[Tuple[str, str], float] = field(default_factory=dict)
    name_sims: Dict[Tuple[str, str], float] = field(default_factory=dict)

    def sim_for(self, student: str, ref: str) -> float:
        for pair in self.pairs:
            if pair.student == student and pair.ref == ref:
                return pair.sim
        return 0.0


def member_norms(members: Sequence[Member]) -> List[str]:
    return [member.norm for member in members if member.norm]


def attribute_similarity(left: Klass, right: Klass, config: Config) -> float:
    """Жаккар по множествам нормализованных имён атрибутов с учётом синонимов."""
    left_names = synonym_keys(member_norms(left.attributes), config.synonyms)
    right_names = synonym_keys(member_norms(right.attributes), config.synonyms)
    if not left_names and not right_names:
        # Ни там, ни там атрибутов нет - это не признак сходства и не признак
        # различия; метрика не должна тянуть пару ни вверх, ни вниз.
        return 0.0
    return jaccard(left_names, right_names)


def context_similarity(
    left: Klass, left_diagram: Diagram, right: Klass, right_diagram: Diagram, config: Config
) -> float:
    """Сходство окрестности: Жаккар по именам соседей и видам связей."""

    def context(klass: Klass, diagram: Diagram) -> Set[str]:
        out: Set[str] = set()
        for relation in diagram.relations:
            if relation.source == klass.ident:
                other = diagram.classes.get(relation.target)
            elif relation.target == klass.ident:
                other = diagram.classes.get(relation.source)
            else:
                continue
            out.add(f"kind:{relation.kind}")
            if other is not None and other.norm:
                out.add(f"neighbour:{config.synonyms.key(other.norm)}")
        return out

    return jaccard(context(left, left_diagram), context(right, right_diagram))


def class_similarity(
    student: Klass,
    student_diagram: Diagram,
    ref: Klass,
    ref_diagram: Diagram,
    config: Config,
) -> Tuple[float, float, float, float]:
    name_sim = name_similarity(
        student.norm, ref.norm, config.synonyms, config.name_min
    )
    attr_sim = attribute_similarity(student, ref, config)
    ctx_sim = context_similarity(student, student_diagram, ref, ref_diagram, config)
    weights = config.match_weights
    sim = (
        weights.get("name", 0.5) * name_sim
        + weights.get("attr", 0.3) * attr_sim
        + weights.get("ctx", 0.2) * ctx_sim
    )
    return sim, name_sim, attr_sim, ctx_sim


def match_classes(
    student_diagram: Diagram, ref_diagram: Diagram, config: Config
) -> ClassMatching:
    student_idents = sorted(student_diagram.classes)
    ref_idents = sorted(ref_diagram.classes)
    matching = ClassMatching()

    if not student_idents or not ref_idents:
        matching.extra = list(student_idents)
        matching.missing = list(ref_idents)
        return matching

    sims: List[List[float]] = []
    details: Dict[Tuple[int, int], Tuple[float, float, float]] = {}
    for row, student_ident in enumerate(student_idents):
        row_values = []
        for column, ref_ident in enumerate(ref_idents):
            sim, name_sim, attr_sim, ctx_sim = class_similarity(
                student_diagram.classes[student_ident],
                student_diagram,
                ref_diagram.classes[ref_ident],
                ref_diagram,
                config,
            )
            row_values.append(sim)
            details[(row, column)] = (name_sim, attr_sim, ctx_sim)
            matching.attr_sims[(student_ident, ref_ident)] = attr_sim
            matching.name_sims[(student_ident, ref_ident)] = name_sim
        sims.append(row_values)

    cost = [[1.0 - value for value in row] for row in sims]
    for row, column in assign(cost):
        sim = sims[row][column]
        if sim < config.match_min:
            continue
        name_sim, attr_sim, ctx_sim = details[(row, column)]
        student_ident, ref_ident = student_idents[row], ref_idents[column]
        matching.pairs.append(
            ClassMatch(
                student=student_ident,
                ref=ref_ident,
                sim=sim,
                name_sim=name_sim,
                attr_sim=attr_sim,
                ctx_sim=ctx_sim,
            )
        )
        matching.by_student[student_ident] = ref_ident
        matching.by_ref[ref_ident] = student_ident

    matching.pairs.sort(key=lambda pair: (pair.student, pair.ref))
    matching.extra = [
        ident for ident in student_idents if ident not in matching.by_student
    ]
    matching.missing = [ident for ident in ref_idents if ident not in matching.by_ref]
    return matching


# --- атрибуты и методы (ТЗ п. 4.2) -----------------------------------------


@dataclass
class MemberMatching:
    matched: List[Tuple[str, str]] = field(default_factory=list)
    extra: List[str] = field(default_factory=list)
    missing: List[str] = field(default_factory=list)


def match_members(
    student_members: Sequence[Member],
    ref_members: Sequence[Member],
    config: Config,
) -> MemberMatching:
    result = MemberMatching()
    student_names = [member.name for member in student_members]
    ref_names = [member.name for member in ref_members]
    if not student_members or not ref_members:
        result.extra = sorted(student_names)
        result.missing = sorted(ref_names)
        return result

    sims = [
        [
            name_similarity(
                student.norm, ref.norm, config.synonyms, config.name_min
            )
            for ref in ref_members
        ]
        for student in student_members
    ]
    cost = [[1.0 - value for value in row] for row in sims]
    used_students: Set[int] = set()
    used_refs: Set[int] = set()
    for row, column in assign(cost):
        if sims[row][column] < config.member_min:
            continue
        used_students.add(row)
        used_refs.add(column)
        result.matched.append((student_members[row].name, ref_members[column].name))

    result.matched.sort()
    result.extra = sorted(
        member.name
        for index, member in enumerate(student_members)
        if index not in used_students
    )
    result.missing = sorted(
        member.name for index, member in enumerate(ref_members) if index not in used_refs
    )
    return result


# --- связи (ТЗ п. 4.3) ------------------------------------------------------

EXACT = "exact"
PARTIAL = "partial"
INVERSION = "inversion"

UNDIRECTED_KINDS = {"association"}


def _normalize_mult(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    text = str(value).strip().replace(" ", "").lower()
    if not text:
        return None
    if text in ("*", "n", "0..n", "*..*", "many", "0..*"):
        return "0..*"
    if text in ("1..n", "1..*", "+"):
        return "1..*"
    if text in ("0..1", "?"):
        return "0..1"
    return text


def multiplicity_score(
    student: Relation, ref: Relation, config: Config, swapped: bool = False
) -> float:
    """Совпадение кратностей: точное - 1.0, совместимое - 0.5 (ТЗ п. 5, C4)."""
    missing_credit = config.partial_credit.get("mult_missing", 0.5)
    student_ends = (
        _normalize_mult(student.src_mult),
        _normalize_mult(student.tgt_mult),
    )
    ref_ends = (_normalize_mult(ref.src_mult), _normalize_mult(ref.tgt_mult))
    if swapped:
        ref_ends = (ref_ends[1], ref_ends[0])

    scores = []
    for left, right in zip(student_ends, ref_ends):
        if left is None and right is None:
            scores.append(1.0)
        elif left is None or right is None:
            scores.append(missing_credit)
        elif left == right:
            scores.append(1.0)
        elif {left, right} <= {"0..*", "1..*", "0..1"}:
            # Разные, но однотипные "много"/"необязательно" - совместимые.
            scores.append(0.5)
        else:
            scores.append(0.0)
    return sum(scores) / len(scores)


@dataclass
class RelationMatch:
    student_index: int
    ref_index: int
    verdict: str  # exact | partial | inversion
    problems: List[str] = field(default_factory=list)
    credit: float = 1.0


@dataclass
class RelationMatching:
    matches: List[RelationMatch] = field(default_factory=list)
    extra: List[int] = field(default_factory=list)  # индексы связей студента
    missing: List[int] = field(default_factory=list)  # индексы связей эталона
    transitive: List[Tuple[int, str]] = field(default_factory=list)


def match_relations(
    student_diagram: Diagram,
    ref_diagram: Diagram,
    classes: ClassMatching,
    config: Config,
) -> RelationMatching:
    result = RelationMatching()
    student_relations = student_diagram.relations
    ref_relations = ref_diagram.relations

    # Связь студента, переведённая в термины эталона: оба конца должны быть
    # сопоставлены, иначе сравнивать нечего.
    translated: Dict[int, Tuple[str, str]] = {}
    for index, relation in enumerate(student_relations):
        source = classes.by_student.get(relation.source)
        target = classes.by_student.get(relation.target)
        if source is not None and target is not None:
            translated[index] = (source, target)

    taken_refs: Set[int] = set()
    taken_students: Set[int] = set()

    def ref_candidates(ends: Tuple[str, str], reverse: bool) -> List[int]:
        wanted = (ends[1], ends[0]) if reverse else ends
        return [
            index
            for index, relation in enumerate(ref_relations)
            if index not in taken_refs
            and (relation.source, relation.target) == wanted
        ]

    def problems_for(student: Relation, ref: Relation, swapped: bool) -> List[str]:
        issues = []
        if student.kind != ref.kind:
            issues.append("kind")
        if student.directed != ref.directed:
            issues.append("direction")
        if multiplicity_score(student, ref, config, swapped) < 1.0:
            issues.append("multiplicity")
        return issues

    # Проход 1: полные совпадения. Проход 2: те же концы, но что-то не так.
    # Проход 3: перевёрнутые концы. Порядок важен - он не даёт частичному
    # совпадению занять связь, для которой есть полное.
    for wanted_exact in (True, False):
        for index in sorted(translated):
            if index in taken_students:
                continue
            student = student_relations[index]
            for ref_index in ref_candidates(translated[index], reverse=False):
                ref = ref_relations[ref_index]
                issues = problems_for(student, ref, swapped=False)
                if wanted_exact and issues:
                    continue
                taken_students.add(index)
                taken_refs.add(ref_index)
                result.matches.append(
                    RelationMatch(
                        student_index=index,
                        ref_index=ref_index,
                        verdict=EXACT if not issues else PARTIAL,
                        problems=issues,
                        credit=1.0
                        if not issues
                        else config.partial_credit.get("relation_kind_mismatch", 0.5),
                    )
                )
                break

    for index in sorted(translated):
        if index in taken_students:
            continue
        student = student_relations[index]
        for ref_index in ref_candidates(translated[index], reverse=True):
            ref = ref_relations[ref_index]
            # Ненаправленная ассоциация, записанная с другого конца, - это та
            # же связь: канонический порядок концов зависит от имён, а они у
            # студента свои.
            swapped_undirected = (
                not student.directed
                and not ref.directed
                and student.kind in UNDIRECTED_KINDS
                and ref.kind in UNDIRECTED_KINDS
            )
            issues = problems_for(student, ref, swapped=True)
            if swapped_undirected:
                verdict = EXACT if not issues else PARTIAL
                credit = (
                    1.0
                    if not issues
                    else config.partial_credit.get("relation_kind_mismatch", 0.5)
                )
            else:
                verdict = INVERSION
                issues = ["inversion"] + issues
                credit = config.partial_credit.get("relation_inversion", 0.25)
            taken_students.add(index)
            taken_refs.add(ref_index)
            result.matches.append(
                RelationMatch(
                    student_index=index,
                    ref_index=ref_index,
                    verdict=verdict,
                    problems=issues,
                    credit=credit,
                )
            )
            break

    result.matches.sort(key=lambda match: (match.student_index, match.ref_index))
    result.extra = [
        index for index in range(len(student_relations)) if index not in taken_students
    ]
    result.missing = [
        index for index in range(len(ref_relations)) if index not in taken_refs
    ]

    if config.transitive_relations:
        result.transitive = _transitive(
            student_diagram, ref_diagram, classes, result
        )
    return result


def _transitive(
    student_diagram: Diagram,
    ref_diagram: Diagram,
    classes: ClassMatching,
    relations: RelationMatching,
) -> List[Tuple[int, str]]:
    """Эталонная связь A->C при студенческом пути A->B->C, где B - лишний класс.

    Учитывается предупреждением (ТЗ п. 4.3), оценку не меняет.
    """
    extra_classes = set(classes.extra)
    if not extra_classes:
        return []

    found: List[Tuple[int, str]] = []
    student_edges: Dict[str, List[str]] = {}
    for relation in student_diagram.relations:
        student_edges.setdefault(relation.source, []).append(relation.target)
        student_edges.setdefault(relation.target, []).append(relation.source)

    for ref_index in relations.missing:
        ref = ref_diagram.relations[ref_index]
        source = classes.by_ref.get(ref.source)
        target = classes.by_ref.get(ref.target)
        if source is None or target is None:
            continue
        for middle in sorted(set(student_edges.get(source, []))):
            if middle in extra_classes and target in student_edges.get(middle, []):
                found.append((ref_index, middle))
                break
    return found
