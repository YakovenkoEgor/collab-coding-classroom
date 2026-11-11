"""Нормализованный граф диаграммы (ТЗ п. 3)."""

from dataclasses import dataclass, field
from typing import Dict, List, Optional

CLASS_KINDS = ("class", "abstract", "interface", "enum")

RELATION_KINDS = (
    "generalization",
    "realization",
    "composition",
    "aggregation",
    "association",
    "dependency",
)


@dataclass
class Member:
    """Атрибут или метод. ``params``/``ret`` заполняются только у методов."""

    name: str
    norm: str = ""
    kind: str = "attribute"  # attribute | method
    type: Optional[str] = None
    params: Optional[str] = None
    ret: Optional[str] = None
    visibility: Optional[str] = None
    static: bool = False
    abstract: bool = False
    line: int = 0


@dataclass
class Klass:
    ident: str  # идентификатор в тексте диаграммы
    name: str  # отображаемое имя (алиас, если он задан)
    kind: str = "class"
    package: Optional[str] = None
    norm: str = ""
    attributes: List[Member] = field(default_factory=list)
    methods: List[Member] = field(default_factory=list)
    line: int = 0
    declared: bool = False  # False - класс возник только из связи


@dataclass
class Relation:
    source: str  # ident класса
    target: str  # ident класса
    kind: str = "association"
    directed: bool = False
    src_mult: Optional[str] = None
    tgt_mult: Optional[str] = None
    label: Optional[str] = None
    line: int = 0


@dataclass
class Diagram:
    classes: Dict[str, Klass] = field(default_factory=dict)
    relations: List[Relation] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    def neighbours(self, ident: str) -> List[str]:
        out = []
        for rel in self.relations:
            if rel.source == ident:
                out.append(rel.target)
            elif rel.target == ident:
                out.append(rel.source)
        return out


class ParseError(Exception):
    """Файл не разбирается. Несёт номер строки - он попадает в отчёт."""

    def __init__(self, message: str, line: int = 0):
        super().__init__(message)
        self.message = message
        self.line = line


class UnsupportedDiagram(Exception):
    """Диаграмма не классов (ТЗ п. 0): вне объёма проверки."""

    def __init__(self, message: str, line: int = 0):
        super().__init__(message)
        self.message = message
        self.line = line
