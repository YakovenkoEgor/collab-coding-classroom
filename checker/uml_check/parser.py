"""Разбор подмножества PlantUML для диаграмм классов (ТЗ п. 2).

Собственный парсер: PlantUML-сервер не используется, студенческий файл
только читается как текст. Разбор строчный - для каждой строки по очереди
пробуются: директива (игнорируется), объявление класса/пакета, тело класса,
член класса вне тела, связь. Непонятая строка даёт предупреждение и не
останавливает проверку (ТЗ п. 2.3).

Связи приводятся к канонической форме сразу (ТЗ п. 3.2): обобщение всегда
записывается "потомок -> предок", композиция и агрегация - "целое -> часть",
ненаправленные ассоциации упорядочены лексикографически по нормализованным
именам концов.
"""

import re
from typing import Dict, List, Optional, Tuple

from .model import Diagram, Klass, Member, ParseError, Relation, UnsupportedDiagram
from .normalize import norm_name

# --- что игнорируется (ТЗ п. 2.3) ------------------------------------------

IGNORED_PREFIXES = (
    "skinparam",
    "hide",
    "show",
    "title",
    "caption",
    "header",
    "footer",
    "scale",
    "allow_mixing",
    "allowmixing",
    "set separator",
    "set namespaceseparator",
    "remove",
    "restore",
    "page",
    "sprite",
    "left to right direction",
    "top to bottom direction",
    "mainframe",
)

BLOCK_OPENERS = {
    "note": "end note",
    "legend": "end legend",
    "style": "end style",
}

# Начала диаграмм других типов и их характерные ключевые слова (ТЗ п. 0).
FOREIGN_STARTS = (
    "@startmindmap",
    "@startsalt",
    "@startjson",
    "@startyaml",
    "@startgantt",
    "@startwbs",
    "@startditaa",
    "@startdot",
    "@startchen",
    "@startchronology",
)

FOREIGN_KEYWORDS = {
    "participant": "диаграмма последовательностей",
    "actor": "диаграмма последовательностей или вариантов использования",
    "boundary": "диаграмма последовательностей",
    "control": "диаграмма последовательностей",
    "collections": "диаграмма последовательностей",
    "autonumber": "диаграмма последовательностей",
    "activate": "диаграмма последовательностей",
    "deactivate": "диаграмма последовательностей",
    "usecase": "диаграмма вариантов использования",
    "state": "диаграмма состояний",
    "object": "диаграмма объектов",
    "component": "диаграмма компонентов",
    "node": "диаграмма развёртывания",
    "artifact": "диаграмма развёртывания",
    "storage": "диаграмма развёртывания",
    "folder": "диаграмма развёртывания",
    "rectangle": "диаграмма развёртывания",
    "cloud": "диаграмма развёртывания",
    "agent": "диаграмма развёртывания",
    "card": "диаграмма развёртывания",
    "person": "диаграмма развёртывания",
    "swimlane": "диаграмма деятельности",
    "partition": "диаграмма деятельности",
    "fork": "диаграмма деятельности",
    "repeat": "диаграмма деятельности",
    "swimlanes": "диаграмма деятельности",
}

# --- разбор объявлений ------------------------------------------------------

DECL_RE = re.compile(
    r"^(?P<kw>abstract\s+class|abstract|class|interface|enum|annotation|entity|struct|protocol)"
    r"\s+(?P<rest>.+)$",
    re.IGNORECASE,
)

PACKAGE_RE = re.compile(
    r"^(?P<kw>package|namespace|together)\b\s*(?P<rest>.*)$", re.IGNORECASE
)

NAME_RE = re.compile(r'^(?:"(?P<quoted>[^"]+)"|(?P<bare>[\w.$]+))(?P<tail>.*)$')

ALIAS_RE = re.compile(r'\bas\s+(?:"(?P<quoted>[^"]+)"|(?P<bare>[\w.$]+))', re.IGNORECASE)

STEREOTYPE_RE = re.compile(r"<<\s*(?P<body>[^>]*?)\s*>>")

KIND_BY_KEYWORD = {
    "class": "class",
    "abstract": "abstract",
    "abstract class": "abstract",
    "interface": "interface",
    "enum": "enum",
    "annotation": "class",
    "entity": "class",
    "struct": "class",
    "protocol": "interface",
}

STEREOTYPE_KINDS = {
    "interface": "interface",
    "интерфейс": "interface",
    "abstract": "abstract",
    "абстрактный": "abstract",
    "enum": "enum",
    "enumeration": "enum",
    "перечисление": "enum",
}

# --- разбор связей ---------------------------------------------------------

END = r"(?:<\||\|>|<|>|\*|o|\+|#|x|\^|\{|\})"

REL_RE = re.compile(
    r'^(?P<left>"[^"]+"|[\w.$]+)\s*'
    r'(?:"(?P<lmult>[^"]*)"\s*)?'
    r"(?P<arrow>" + END + r"?[-.]{1,4}" + END + r"?)"
    r'\s*(?:"(?P<rmult>[^"]*)"\s*)?'
    r'(?P<right>"[^"]+"|[\w.$]+)\s*'
    r"(?::\s*(?P<label>.*))?$"
)

# `A -up-> B`, `A -[#red]-> B`, `A -[hidden]- B`: длина, цвет и стиль связи
# на смысл не влияют, поэтому стираются до разбора.
DIRECTION_RE = re.compile(r"-(?:up|down|left|right)-", re.IGNORECASE)
STYLE_RE = re.compile(r"(?<=[-.])\[[^\]]*\](?=[-.>|*o])|(?<=[-.])\[[^\]]*\]")

MEMBER_MODIFIER_RE = re.compile(r"\{\s*(static|abstract|field|method)\s*\}", re.IGNORECASE)
SEPARATOR_RE = re.compile(r"^(?:--|==|\.\.|__)[^-=._]*(?:--|==|\.\.|__)?$")
VISIBILITY = {"+": "public", "-": "private", "#": "protected", "~": "package"}


def _unquote(raw: Optional[str]) -> str:
    text = (raw or "").strip()
    if len(text) >= 2 and text[0] == '"' and text[-1] == '"':
        return text[1:-1].strip()
    return text


def _marker_kind(marks: str) -> Optional[str]:
    if "|" in marks:
        return "generalization"
    if "*" in marks:
        return "composition"
    if "o" in marks:
        return "aggregation"
    if "+" in marks:
        return "composition"
    if any(char in marks for char in "<>#x^{}"):
        return "arrow"
    return None


def classify_arrow(arrow: str) -> Tuple[str, Optional[str], bool]:
    """Стрелка -> (вид связи, где голова: 'left'/'right'/None, пунктир)."""
    body_positions = [index for index, char in enumerate(arrow) if char in "-."]
    first, last = body_positions[0], body_positions[-1]
    left_marks, right_marks = arrow[:first], arrow[last + 1 :]
    dotted = "." in arrow

    left_kind, right_kind = _marker_kind(left_marks), _marker_kind(right_marks)

    for kind_name in ("generalization", "composition", "aggregation"):
        if left_kind == kind_name or right_kind == kind_name:
            if kind_name == "generalization":
                kind = "realization" if dotted else "generalization"
            else:
                kind = kind_name
            head = "left" if left_kind == kind_name else "right"
            return kind, head, dotted

    if left_kind == "arrow" and right_kind == "arrow":
        # Двусторонняя стрелка - та же ассоциация, просто без выделенного конца.
        return ("dependency" if dotted else "association"), None, dotted
    if right_kind == "arrow":
        return ("dependency" if dotted else "association"), "right", dotted
    if left_kind == "arrow":
        return ("dependency" if dotted else "association"), "left", dotted
    return "association", None, dotted


class _Parser:
    def __init__(self, text: str):
        self.text = text
        self.diagram = Diagram()
        self.raw_relations: List[dict] = []
        self.package_stack: List[str] = []
        self.current_class: Optional[Klass] = None
        self.warned: set = set()

    # --- служебное ---------------------------------------------------------
    def warn(self, message: str) -> None:
        if message not in self.warned:
            self.warned.add(message)
            self.diagram.warnings.append(message)

    def klass(self, ident: str, line: int = 0) -> Klass:
        existing = self.diagram.classes.get(ident)
        if existing:
            return existing
        created = Klass(
            ident=ident,
            name=ident,
            kind="class",
            package=self.package_stack[-1] if self.package_stack else None,
            norm=norm_name(ident),
            line=line,
        )
        self.diagram.classes[ident] = created
        return created

    # --- строки -----------------------------------------------------------
    def strip_comments(self) -> List[Tuple[int, str]]:
        """Убрать блочные комментарии, вернуть (номер строки, текст)."""
        text = self.text.replace("\r\n", "\n").replace("\r", "\n")
        out: List[Tuple[int, str]] = []
        in_block = False
        for number, raw in enumerate(text.split("\n"), start=1):
            line = raw
            if in_block:
                closing = line.find("'/")
                if closing < 0:
                    continue
                line = line[closing + 2 :]
                in_block = False
            while True:
                opening = line.find("/'")
                if opening < 0:
                    break
                closing = line.find("'/", opening + 2)
                if closing < 0:
                    line = line[:opening]
                    in_block = True
                    break
                line = line[:opening] + line[closing + 2 :]
            stripped = line.strip()
            if stripped.startswith("'"):
                continue
            out.append((number, stripped))
        return out

    def parse(self) -> Diagram:
        lines = self.strip_comments()
        self.check_foreign(lines)

        skip_until: Optional[str] = None
        for number, line in lines:
            if not line:
                continue
            lowered = line.lower()

            if skip_until is not None:
                if lowered.startswith(skip_until):
                    skip_until = None
                continue

            if lowered.startswith("@start") or lowered.startswith("@end"):
                continue
            if line.startswith("!"):
                if lowered.startswith("!include"):
                    self.warn("Директива !include проигнорирована: внешние файлы не читаются")
                else:
                    self.warn(f"Директива препроцессора в строке {number} проигнорирована")
                continue
            if any(lowered.startswith(prefix) for prefix in IGNORED_PREFIXES):
                continue

            block = next(
                (opener for opener in BLOCK_OPENERS if lowered.startswith(opener)), None
            )
            if block:
                # Однострочная форма (`note right of A : текст`) конца не требует.
                if ":" not in line and not lowered.startswith(block + " \""):
                    skip_until = BLOCK_OPENERS[block]
                self.warn(f"Элемент «{block}» не поддерживается и проигнорирован")
                continue

            if self.handle_block_end(line):
                continue
            if self.handle_package(number, line):
                continue
            if self.current_class is not None:
                self.handle_member_line(number, line)
                continue
            if self.handle_declaration(number, line):
                continue
            if self.handle_relation(number, line):
                continue
            if self.handle_external_member(number, line):
                continue
            self.warn(f"Строка {number} не распознана и проигнорирована: {line[:60]}")

        if not self.diagram.classes:
            raise ParseError("В диаграмме нет ни одного класса", 0)

        self.finalize_relations()
        return self.diagram

    def check_foreign(self, lines: List[Tuple[int, str]]) -> None:
        for number, line in lines:
            lowered = line.lower()
            for start in FOREIGN_STARTS:
                if lowered.startswith(start):
                    raise UnsupportedDiagram(
                        f"Это не диаграмма классов ({start})", number
                    )
            if lowered.startswith("(*)") or re.match(r"^:.+;$", line):
                raise UnsupportedDiagram("Это диаграмма деятельности", number)
            match = re.match(r"^([a-zA-Z_]+)\b", line)
            if not match:
                continue
            keyword = match.group(1).lower()
            if keyword in FOREIGN_KEYWORDS and not DECL_RE.match(line):
                raise UnsupportedDiagram(
                    f"Это не диаграмма классов: {FOREIGN_KEYWORDS[keyword]} "
                    f"(ключевое слово «{keyword}»)",
                    number,
                )

    # --- обработчики -------------------------------------------------------
    def handle_block_end(self, line: str) -> bool:
        if line != "}" and not line.startswith("}"):
            return False
        if self.current_class is not None:
            self.current_class = None
        elif self.package_stack:
            self.package_stack.pop()
        return True

    def handle_package(self, number: int, line: str) -> bool:
        match = PACKAGE_RE.match(line)
        if not match:
            return False
        rest = match.group("rest").strip()
        if match.group("kw").lower() == "together":
            self.package_stack.append("")
            return True
        name_match = NAME_RE.match(rest) if rest else None
        name = ""
        if name_match:
            name = name_match.group("quoted") or name_match.group("bare") or ""
        # Пакет - атрибут принадлежности, а не узел графа (ТЗ п. 2.4).
        self.package_stack.append(name)
        return True

    def handle_declaration(self, number: int, line: str) -> bool:
        match = DECL_RE.match(line)
        if not match:
            return False
        keyword = re.sub(r"\s+", " ", match.group("kw").strip().lower())
        rest = match.group("rest").strip()

        opens_body = rest.rstrip().endswith("{")
        if opens_body:
            rest = rest.rstrip()[:-1].strip()

        stereotype = None
        stereo_match = STEREOTYPE_RE.search(rest)
        if stereo_match:
            stereotype = stereo_match.group("body").strip().lower()
            rest = STEREOTYPE_RE.sub(" ", rest).strip()

        rest = re.sub(r"#[\w|/\\]+\s*$", "", rest).strip()

        alias = None
        alias_match = ALIAS_RE.search(rest)
        if alias_match:
            alias = alias_match.group("quoted") or alias_match.group("bare")
            rest = rest[: alias_match.start()].strip()

        name_match = NAME_RE.match(rest)
        if not name_match:
            return False
        display = name_match.group("quoted") or name_match.group("bare")
        ident = alias or display

        kind = KIND_BY_KEYWORD.get(keyword, "class")
        if stereotype in STEREOTYPE_KINDS:
            kind = STEREOTYPE_KINDS[stereotype]

        klass = self.klass(ident, number)
        klass.name = display
        klass.norm = norm_name(display)
        klass.kind = kind
        klass.declared = True
        klass.line = number
        if self.package_stack and self.package_stack[-1]:
            klass.package = self.package_stack[-1]

        if opens_body:
            self.current_class = klass
        return True

    def handle_member_line(self, number: int, line: str) -> None:
        if line.startswith("}"):
            self.current_class = None
            return
        if SEPARATOR_RE.match(line) or re.match(r"^[-=._]{2,}$", line):
            return
        if STEREOTYPE_RE.fullmatch(line):
            return
        member = parse_member(line, number)
        if member is None:
            self.warn(f"Строка {number} внутри класса не распознана: {line[:60]}")
            return
        if member.kind == "method":
            self.current_class.methods.append(member)
        else:
            self.current_class.attributes.append(member)

    def handle_external_member(self, number: int, line: str) -> bool:
        match = re.match(r'^(?P<owner>"[^"]+"|[\w.$]+)\s*:\s*(?P<body>.+)$', line)
        if not match:
            return False
        owner = _unquote(match.group("owner"))
        member = parse_member(match.group("body").strip(), number)
        if member is None:
            return False
        klass = self.klass(owner, number)
        if member.kind == "method":
            klass.methods.append(member)
        else:
            klass.attributes.append(member)
        return True

    def handle_relation(self, number: int, line: str) -> bool:
        cleaned = STYLE_RE.sub("", DIRECTION_RE.sub("--", line))
        if "[hidden]" in line.lower():
            self.warn(f"Скрытая связь в строке {number} проигнорирована")
            return True
        match = REL_RE.match(cleaned)
        if not match:
            return False

        left = _unquote(match.group("left"))
        right = _unquote(match.group("right"))
        if not left or not right:
            return False

        kind, head, _ = classify_arrow(match.group("arrow"))
        label = (match.group("label") or "").strip() or None
        label_head = None
        if label:
            if label.endswith(">"):
                label, label_head = label[:-1].strip() or None, "right"
            elif label.startswith("<"):
                label, label_head = label[1:].strip() or None, "left"

        self.klass(left, number)
        self.klass(right, number)
        self.raw_relations.append(
            {
                "left": left,
                "right": right,
                "kind": kind,
                "head": head or label_head,
                "lmult": (match.group("lmult") or "").strip() or None,
                "rmult": (match.group("rmult") or "").strip() or None,
                "label": label,
                "line": number,
            }
        )
        return True

    # --- канонизация (ТЗ п. 3.2) -------------------------------------------
    def finalize_relations(self) -> None:
        for raw in self.raw_relations:
            left, right = raw["left"], raw["right"]
            lmult, rmult = raw["lmult"], raw["rmult"]
            kind, head = raw["kind"], raw["head"]

            if kind in ("generalization", "realization"):
                # Голова ("|") стоит у предка; каноническая запись - потомок -> предок.
                if head == "left":
                    source, target = right, left
                    lmult, rmult = rmult, lmult
                else:
                    source, target = left, right
                directed = True
            elif kind in ("composition", "aggregation"):
                # Маркер ("*" или "o") стоит у целого; запись - целое -> часть.
                if head == "right":
                    source, target = right, left
                    lmult, rmult = rmult, lmult
                else:
                    source, target = left, right
                directed = True
            elif head in ("left", "right"):
                if head == "left":
                    source, target = right, left
                    lmult, rmult = rmult, lmult
                else:
                    source, target = left, right
                directed = True
            else:
                source, target = left, right
                directed = False
                left_norm = self.diagram.classes[left].norm or left
                right_norm = self.diagram.classes[right].norm or right
                if (right_norm, right) < (left_norm, left):
                    source, target = right, left
                    lmult, rmult = rmult, lmult

            self.diagram.relations.append(
                Relation(
                    source=source,
                    target=target,
                    kind=kind,
                    directed=directed,
                    src_mult=lmult,
                    tgt_mult=rmult,
                    label=raw["label"],
                    line=raw["line"],
                )
            )


def parse_member(body: str, line: int) -> Optional[Member]:
    """Строка-член класса -> Member. None, если строка не похожа на член."""
    text = body.strip()
    if not text:
        return None

    static = False
    abstract = False
    forced_kind: Optional[str] = None
    for match in MEMBER_MODIFIER_RE.finditer(text):
        modifier = match.group(1).lower()
        if modifier == "static":
            static = True
        elif modifier == "abstract":
            abstract = True
        elif modifier == "field":
            forced_kind = "attribute"
        elif modifier == "method":
            forced_kind = "method"
    text = MEMBER_MODIFIER_RE.sub(" ", text).strip()
    text = STEREOTYPE_RE.sub(" ", text).strip()
    if not text:
        return None

    visibility = None
    if text[0] in VISIBILITY:
        visibility = VISIBILITY[text[0]]
        text = text[1:].strip()
    if not text:
        return None

    is_method = "(" in text and ")" in text
    if forced_kind == "method":
        is_method = True
    elif forced_kind == "attribute":
        is_method = False

    if is_method:
        match = re.match(r"^(?P<head>[^()]*)\((?P<params>[^()]*)\)\s*(?::?\s*(?P<ret>.*))?$", text)
        if not match:
            return None
        head = match.group("head").strip()
        ret = (match.group("ret") or "").strip() or None
        tokens = head.split()
        if not tokens:
            return None
        name = tokens[-1]
        if len(tokens) > 1 and ret is None:
            # Java-порядок: `void пересчитать()`.
            ret = " ".join(tokens[:-1])
        params = (match.group("params") or "").strip() or None
        if not re.match(r"^[\w.$]+$", name):
            return None
        return Member(
            name=name,
            norm=norm_name(name),
            kind="method",
            params=params,
            ret=ret,
            visibility=visibility,
            static=static,
            abstract=abstract,
            line=line,
        )

    if ":" in text:
        name_part, type_part = text.split(":", 1)
        name = name_part.strip()
        type_name = type_part.strip() or None
    else:
        tokens = text.split()
        if len(tokens) == 1:
            name, type_name = tokens[0], None
        elif len(tokens) == 2:
            type_name, name = tokens[0], tokens[1]
        else:
            return None

    if not re.match(r"^[\w.$]+$", name):
        return None
    return Member(
        name=name,
        norm=norm_name(name),
        kind="attribute",
        type=type_name,
        visibility=visibility,
        static=static,
        abstract=abstract,
        line=line,
    )


def parse_diagram(text: str) -> Diagram:
    return _Parser(text).parse()
