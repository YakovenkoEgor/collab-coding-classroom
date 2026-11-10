"""CLI (ТЗ п. 11):

    uml-check --config task_config.yaml --student student.puml --out report.json

Код возврата: 0 - проверка выполнена (любой вердикт), 2 - проверку выполнить
не удалось (нет файла, битая конфигурация). Вердикт читается из отчёта, а не
из кода возврата: "не принято" - это нормальный результат работы, а не сбой.
"""

import argparse
import json
import sys
from typing import List, Optional

from .api import check
from .config import ConfigError, load_config
from .report import Report


def _write(path: Optional[str], text: str) -> None:
    if not path or path == "-":
        sys.stdout.write(text)
        return
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(text)


def _json_text(report: Report) -> str:
    return (
        json.dumps(report.data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    )


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="uml-check",
        description="Проверка UML-диаграммы классов на соответствие эталонам задания",
    )
    parser.add_argument("--config", required=True, help="task_config.yaml задания")
    parser.add_argument("--student", required=True, help="файл студента (.puml)")
    parser.add_argument("--out", help="куда положить JSON-отчёт (по умолчанию stdout)")
    parser.add_argument("--md", help="куда положить отчёт для преподавателя (markdown)")
    parser.add_argument(
        "--student-md", help="куда положить отчёт для студента (markdown, без эталона)"
    )
    parser.add_argument(
        "--quiet", action="store_true", help="не печатать вердикт в stderr"
    )
    args = parser.parse_args(argv)

    try:
        config = load_config(args.config)
        with open(args.student, "r", encoding="utf-8") as handle:
            student_text = handle.read()
    except (OSError, ConfigError) as error:
        sys.stderr.write(f"uml-check: {error}\n")
        return 2
    except Exception as error:  # битый YAML и прочее
        sys.stderr.write(f"uml-check: не удалось прочитать входные данные: {error}\n")
        return 2

    report = check(config, student_text)

    _write(args.out, _json_text(report))
    if args.md:
        _write(args.md, report.markdown)
    if args.student_md:
        _write(args.student_md, report.student_markdown)
    if not args.quiet:
        score = report.score
        sys.stderr.write(
            f"{report.verdict}"
            + (f" (score {score:.3f})" if score is not None else "")
            + "\n"
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
