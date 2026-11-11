"""Юнит-тесты парсера (ТЗ п. 10.1).

Каждая конструкция подмножества из п. 2.4 проверяется минимум на двух
примерах, плюс пять ошибочных файлов.
"""

import pytest

from uml_check.model import ParseError, UnsupportedDiagram
from uml_check.parser import classify_arrow, parse_diagram


def parse(body: str):
    return parse_diagram("@startuml\n" + body + "\n@enduml\n")


def kinds(diagram):
    return {ident: klass.kind for ident, klass in diagram.classes.items()}


def relation_tuples(diagram):
    return [
        (relation.kind, relation.source, relation.target, relation.directed)
        for relation in diagram.relations
    ]


# --- объявления ------------------------------------------------------------


@pytest.mark.parametrize(
    "body,expected",
    [
        ("class Клиент", {"Клиент": "class"}),
        ("class Account {\n}", {"Account": "class"}),
        ("abstract class Счёт", {"Счёт": "abstract"}),
        ("abstract Счёт", {"Счёт": "abstract"}),
        ("interface Платёжный", {"Платёжный": "interface"}),
        ("interface Runnable {\n+run()\n}", {"Runnable": "interface"}),
        ("enum ТипСчёта", {"ТипСчёта": "enum"}),
        ("enum Status {\nNEW\nDONE\n}", {"Status": "enum"}),
    ],
)
def test_class_kinds(body, expected):
    assert kinds(parse(body)) == expected


def test_stereotype_overrides_kind():
    diagram = parse("class Платёжный <<interface>>")
    assert diagram.classes["Платёжный"].kind == "interface"


@pytest.mark.parametrize(
    "body,ident,name",
    [
        ('class "Депозитный счёт" as Депозит', "Депозит", "Депозитный счёт"),
        ("class Клиент as К", "К", "Клиент"),
    ],
)
def test_alias(body, ident, name):
    diagram = parse(body)
    assert ident in diagram.classes
    assert diagram.classes[ident].name == name


@pytest.mark.parametrize("keyword", ["package", "namespace"])
def test_package_is_an_attribute_not_a_node(keyword):
    diagram = parse(f"{keyword} Банк {{\n  class Клиент\n}}\nclass Внешний")
    # Пакет не узел графа (ТЗ п. 2.4).
    assert set(diagram.classes) == {"Клиент", "Внешний"}
    assert diagram.classes["Клиент"].package == "Банк"
    assert diagram.classes["Внешний"].package is None


# --- члены классов ---------------------------------------------------------


@pytest.mark.parametrize(
    "line,name,type_name,visibility",
    [
        ("+фио : String", "фио", "String", "public"),
        ("-баланс : double", "баланс", "double", "private"),
        ("#код", "код", None, "protected"),
        ("int количество", "количество", "int", None),
    ],
)
def test_attributes(line, name, type_name, visibility):
    diagram = parse("class A {\n" + line + "\n}")
    attribute = diagram.classes["A"].attributes[0]
    assert (attribute.name, attribute.type, attribute.visibility) == (
        name,
        type_name,
        visibility,
    )


@pytest.mark.parametrize(
    "line,name,params,ret",
    [
        ("+открыть(номер: String) : Счёт", "открыть", "номер: String", "Счёт"),
        ("+run()", "run", None, None),
        ("void пересчитать()", "пересчитать", None, "void"),
        ("-считать(a: int, b: int) : int", "считать", "a: int, b: int", "int"),
    ],
)
def test_methods(line, name, params, ret):
    diagram = parse("class A {\n" + line + "\n}")
    method = diagram.classes["A"].methods[0]
    assert (method.name, method.params, method.ret) == (name, params, ret)


@pytest.mark.parametrize(
    "line,static,abstract",
    [
        ("{static} +количество : int", True, False),
        ("{abstract} +начислить()", False, True),
    ],
)
def test_member_modifiers(line, static, abstract):
    diagram = parse("class A {\n" + line + "\n}")
    members = diagram.classes["A"].attributes + diagram.classes["A"].methods
    assert (members[0].static, members[0].abstract) == (static, abstract)


@pytest.mark.parametrize(
    "body",
    [
        "class A {\n+поле : int\n}",
        "class A\nA : +поле : int",
    ],
)
def test_both_member_notations(body):
    """Обе формы записи дают один результат (ТЗ п. 2.4)."""
    diagram = parse(body)
    assert [member.name for member in diagram.classes["A"].attributes] == ["поле"]


def test_separators_and_notes_are_ignored():
    diagram = parse(
        "class A {\n"
        "  +поле : int\n"
        "  --\n"
        "  -- Методы --\n"
        "  +метод()\n"
        "  ..\n"
        "  __\n"
        "}\n"
        "note right of A : комментарий"
    )
    assert [member.name for member in diagram.classes["A"].attributes] == ["поле"]
    assert [member.name for member in diagram.classes["A"].methods] == ["метод"]


# --- связи -----------------------------------------------------------------


@pytest.mark.parametrize(
    "line,expected",
    [
        # Обобщение: каноническая форма - потомок -> предок (ТЗ п. 3.2).
        ("A <|-- B", ("generalization", "B", "A", True)),
        ("B --|> A", ("generalization", "B", "A", True)),
        ("A <|.. B", ("realization", "B", "A", True)),
        ("B ..|> A", ("realization", "B", "A", True)),
        # Композиция и агрегация: целое -> часть.
        ("A *-- B", ("composition", "A", "B", True)),
        ("B --* A", ("composition", "A", "B", True)),
        ("A o-- B", ("aggregation", "A", "B", True)),
        ("B --o A", ("aggregation", "A", "B", True)),
        # Ассоциация и зависимость.
        ("A --> B", ("association", "A", "B", True)),
        ("B <-- A", ("association", "A", "B", True)),
        ("A -- B", ("association", "A", "B", False)),
        ("A ..> B", ("dependency", "A", "B", True)),
    ],
)
def test_relation_forms(line, expected):
    assert relation_tuples(parse(line)) == [expected]


@pytest.mark.parametrize(
    "line,src,tgt",
    [
        ('A "1" --> "0..*" B', "1", "0..*"),
        ('A "1..*" -- "1" B', "1..*", "1"),
    ],
)
def test_multiplicities(line, src, tgt):
    relation = parse(line).relations[0]
    assert (relation.src_mult, relation.tgt_mult) == (src, tgt)


@pytest.mark.parametrize(
    "line,label",
    [
        ("A --> B : содержит", "содержит"),
        ("A -- B : содержит >", "содержит"),
    ],
)
def test_relation_labels(line, label):
    assert parse(line).relations[0].label == label


def test_undirected_association_is_ordered_lexicographically():
    """`B -- A` и `A -- B` - одна и та же связь (ТЗ п. 3.2)."""
    first = relation_tuples(parse("class A\nclass B\nA -- B"))
    second = relation_tuples(parse("class A\nclass B\nB -- A"))
    assert first == second == [("association", "A", "B", False)]


@pytest.mark.parametrize(
    "line", ["A -up-> B", "A -[#red]-> B", "A -down-> B", "A -[#blue,dashed]-> B"]
)
def test_arrow_decorations_do_not_change_meaning(line):
    assert relation_tuples(parse(line)) == [("association", "A", "B", True)]


def test_hidden_relation_is_skipped_with_a_warning():
    diagram = parse("class A\nclass B\nA -[hidden]- B")
    assert diagram.relations == []
    assert any("крыт" in warning for warning in diagram.warnings)


@pytest.mark.parametrize(
    "arrow,kind",
    [
        ("<|--", "generalization"),
        ("..|>", "realization"),
        ("*--", "composition"),
        ("o--", "aggregation"),
        ("-->", "association"),
        ("--", "association"),
        ("..>", "dependency"),
    ],
)
def test_classify_arrow(arrow, kind):
    assert classify_arrow(arrow)[0] == kind


# --- игнорируемое ----------------------------------------------------------


def test_directives_are_ignored_and_include_warns():
    diagram = parse(
        "left to right direction\n"
        "skinparam shadowing false\n"
        "hide empty members\n"
        "title Диаграмма\n"
        "!include common.puml\n"
        "together {\n  class A\n}\n"
        "' просто комментарий\n"
        "/' блочный\nкомментарий '/\n"
        "class B"
    )
    assert set(diagram.classes) == {"A", "B"}
    assert any("include" in warning for warning in diagram.warnings)


# --- ошибочные файлы (пять штук) -------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "",
        "@startuml\n@enduml\n",
        "@startuml\nskinparam shadowing false\ntitle Пусто\n@enduml\n",
        "совершенно не диаграмма, просто текст\n",
        "@startuml\n!include другое.puml\n@enduml\n",
    ],
)
def test_broken_files_raise_parse_error(text):
    with pytest.raises(ParseError):
        parse_diagram(text)


@pytest.mark.parametrize(
    "text",
    [
        "@startuml\nparticipant Клиент\nКлиент -> Сервер : запрос\n@enduml\n",
        "@startmindmap\n* корень\n@endmindmap\n",
        "@startuml\nstate Ожидание\nstate Готово\nОжидание --> Готово\n@enduml\n",
        "@startuml\nobject клиент1\n@enduml\n",
    ],
)
def test_other_diagram_kinds_are_unsupported(text):
    with pytest.raises(UnsupportedDiagram):
        parse_diagram(text)
