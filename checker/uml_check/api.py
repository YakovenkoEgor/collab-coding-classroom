"""Библиотечный API (ТЗ п. 11): ``check(config, student_text) -> Report``."""

import os
from typing import Dict, List, Optional, Sequence, Tuple

from .config import Config, load_config
from .metrics import Analysis, analyse
from .model import Diagram, ParseError, UnsupportedDiagram
from .parser import parse_diagram
from .report import Report, build
from .verdict import decide, gate_failure


def _ref_id(path: str, index: int) -> str:
    stem = os.path.splitext(os.path.basename(path))[0]
    return stem or f"ref_{index + 1}"


def read_refs(config: Config) -> List[Tuple[str, str]]:
    """Эталоны с диска в порядке, указанном в конфигурации."""
    refs = []
    for index, path in enumerate(config.ref_paths()):
        with open(path, "r", encoding="utf-8") as handle:
            refs.append((_ref_id(config.refs[index], index), handle.read()))
    return refs


def check(
    config: Config,
    student_text: str,
    refs: Optional[Sequence[Tuple[str, str]]] = None,
) -> Report:
    """Проверить один файл студента против эталонов задания.

    ``refs`` - пары (идентификатор, текст). Если не передано, эталоны читаются
    по путям из конфигурации.
    """
    if refs is None:
        refs = read_refs(config)
    refs = list(refs)
    config_hash = config.config_hash([text for _, text in refs])

    # --- C0: ворота разбора (ТЗ п. 2) --------------------------------------
    try:
        student = parse_diagram(student_text or "")
    except UnsupportedDiagram as error:
        verdict = gate_failure(
            "unsupported_diagram",
            f"{error.message} (строка {error.line})" if error.line else error.message,
        )
        return build(verdict, None, [], None, {}, config, config_hash)
    except ParseError as error:
        verdict = gate_failure(
            "parse_error",
            f"файл не разбирается: {error.message}"
            + (f", строка {error.line}" if error.line else ""),
        )
        return build(verdict, None, [], None, {}, config, config_hash)

    if not refs:
        verdict = gate_failure(
            "no_references", "у задания не задано ни одного эталона"
        )
        return build(verdict, None, [], student, {}, config, config_hash)

    # --- эталоны ------------------------------------------------------------
    parsed: Dict[str, Diagram] = {}
    warnings: List[str] = []
    for ref_id, text in refs:
        try:
            parsed[ref_id] = parse_diagram(text)
        except (ParseError, UnsupportedDiagram) as error:
            warnings.append(
                f"Эталон {ref_id} не разбирается и пропущен: {error.message}"
            )

    if not parsed:
        verdict = gate_failure(
            "reference_parse_error", "ни один эталон задания не разбирается"
        )
        return build(verdict, None, [], student, {}, config, config_hash, warnings)

    # --- сравнение с каждым эталоном (ТЗ п. 5) ------------------------------
    analyses: List[Analysis] = [
        analyse(student, parsed[ref_id], ref_id, config) for ref_id in sorted(parsed)
    ]
    # Усреднять по эталонам запрещено (ТЗ п. 5): берётся лучший. При равенстве
    # счёта побеждает эталон, с которым лучше сошлись имена классов (решение
    # студента, дословно совпавшее с одним из эталонов, должно указывать на
    # него, а не на его синонимичный вариант), затем - первый по имени.
    order = sorted(
        analyses, key=lambda item: (-item.score, -item.match_quality, item.ref_id)
    )
    ranked = [(item.ref_id, item.score) for item in order]
    best = order[0]

    ref_class_count = len(parsed[best.ref_id].classes)
    verdict = decide(best, ranked, config, ref_class_count)
    return build(
        verdict, best, ranked, student, parsed, config, config_hash, warnings
    )


def check_files(config_path: str, student_path: str) -> Report:
    config = load_config(config_path)
    with open(student_path, "r", encoding="utf-8") as handle:
        return check(config, handle.read())
