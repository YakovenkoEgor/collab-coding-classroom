"""Метаморфические тесты (ТЗ п. 10.2).

Проверяется не конкретное число, а свойства проверки: от чего результат не
должен зависеть и в какую сторону он обязан меняться.
"""

import os
import random

import pytest

from uml_check import check, load_config
from uml_check.config import load_config_data

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "bank")


def read(name: str) -> str:
    with open(os.path.join(FIXTURES, name), "r", encoding="utf-8") as handle:
        return handle.read()


@pytest.fixture(scope="module")
def config():
    return load_config(os.path.join(FIXTURES, "task_config.yaml"))


@pytest.fixture(scope="module")
def refs():
    return [("ref_1", read("ref_1.puml")), ("ref_2", read("ref_2.puml"))]


def score(config, text, refs):
    return check(config, text, refs).score


# --- 1. Порядок записи ------------------------------------------------------


def shuffle_body(text: str, seed: int) -> str:
    """Перетасовать объявления и связи, не меняя самой диаграммы.

    Блок - строка верхнего уровня или объявление класса целиком: блоки
    нарезаются по балансу фигурных скобок.
    """
    newline = chr(10)
    blocks = []
    current = []
    depth = 0
    for line in text.replace(chr(13), "").split(newline):
        if not line.strip() or line.startswith("@start") or line.startswith("@end"):
            continue
        current.append(line)
        depth += line.count("{") - line.count("}")
        if depth == 0:
            blocks.append(newline.join(current))
            current = []
    if current:
        blocks.append(newline.join(current))
    random.Random(seed).shuffle(blocks)
    return newline.join(["@startuml", *blocks, "@enduml", ""])


@pytest.mark.parametrize("seed", [1, 2, 3, 17])
def test_order_does_not_change_the_score(config, refs, seed):
    original = read("student_imperfect.puml")
    shuffled = shuffle_body(original, seed)
    assert score(config, shuffled, refs) == pytest.approx(
        score(config, original, refs), abs=1e-9
    )


# --- 2. Эталон против самого себя ------------------------------------------


@pytest.mark.parametrize("ref_name", ["ref_1.puml", "ref_2.puml"])
def test_reference_against_itself_is_one(config, refs, ref_name):
    assert score(config, read(ref_name), refs) == pytest.approx(1.0, abs=1e-9)


# --- 3. Синонимы -----------------------------------------------------------


def test_synonyms_do_not_change_the_score(config):
    """Переименование в синоним из словаря задания счёт не меняет."""
    single = [("ref_1", read("ref_1.puml"))]
    original = read("ref_1.puml")
    renamed = original.replace("Клиент", "Заказчик").replace("Счёт", "Аккаунт")
    assert score(config, renamed, single) == pytest.approx(
        score(config, original, single), abs=1e-9
    )


def test_rename_without_synonym_lowers_the_score(config):
    """А переименование не в синоним - меняет: иначе имена не значили бы ничего."""
    single = [("ref_1", read("ref_1.puml"))]
    renamed = read("ref_1.puml").replace("Клиент", "Шестерёнка")
    assert score(config, renamed, single) < 1.0


# --- 4. Монотонность -------------------------------------------------------


def test_removing_classes_lowers_the_score_monotonically(config, refs):
    """Чем больше выброшено, тем ниже счёт."""
    newline = chr(10)
    full = read("ref_1.puml")
    without_one = full.replace(
        newline.join(["class Платёж {", "  +получатель : String", "}", ""]), ""
    ).replace("Операция <|-- Платёж" + newline, "")
    without_two = without_one.replace(
        newline.join(
            ["class Операция {", "  +дата : Date", "  +сумма : double", "}", ""]
        ),
        "",
    ).replace('Счёт "1" o-- "0..*" Операция' + newline, "")

    assert without_one != full
    assert without_two != without_one

    scores = [
        score(config, full, refs),
        score(config, without_one, refs),
        score(config, without_two, refs),
    ]
    assert scores[0] > scores[1] > scores[2]


def test_removing_a_relation_lowers_the_score(config, refs):
    full = read("ref_1.puml")
    without_relation = full.replace(
        'Счёт "1" o-- "0..*" Операция' + chr(10), ""
    )
    assert without_relation != full
    assert score(config, without_relation, refs) < score(config, full, refs)


# --- 5. Любой эталон принимается -------------------------------------------


@pytest.mark.parametrize("ref_id", ["ref_1", "ref_2"])
def test_each_reference_is_accepted_and_recognised(config, refs, ref_id):
    report = check(config, read(f"{ref_id}.puml"), refs)
    assert report.verdict == "accepted"
    assert report.data["best_reference"] == ref_id


# --- дополнительно: воспроизводимость и неразглашение эталона --------------


def test_two_runs_give_the_same_report(config, refs):
    """Один вход - один выход (ТЗ п. 0): отчёты совпадают целиком."""
    text = read("student_imperfect.puml")
    first = check(config, text, refs)
    second = check(config, text, refs)
    assert first.data == second.data
    assert first.markdown == second.markdown
    assert first.student_markdown == second.student_markdown


def test_student_report_never_names_reference_only_classes():
    """Отчёт студенту не раскрывает текст эталона (ТЗ п. 8)."""
    single = [("ref_1", read("ref_1.puml"))]
    newline = chr(10)
    student = newline.join(
        ["@startuml", "class Клиент", "class Счёт", "Клиент -- Счёт", "@enduml", ""]
    )
    report = check(load_config_data({}, FIXTURES), student, single)
    # "Платёж" и "Операция" есть только в эталоне - их имена всплыть не должны.
    assert "Платёж" not in report.student_markdown
    assert "Операция" not in report.student_markdown
