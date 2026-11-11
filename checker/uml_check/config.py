"""Конфигурация задания (ТЗ п. 9).

Все числа проверки берутся отсюда: в коде нет "магических" порогов.
Значения по умолчанию - те же, что в ТЗ; задание переопределяет любое из них.
"""

import hashlib
import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

from .normalize import Synonyms, norm_name

DEFAULTS: Dict[str, Any] = {
    "task_id": "",
    "refs": [],
    "language": "ru",
    "synonyms": {},
    "required_classes": [],
    "required_relations": [],
    "weights": {"c1": 0.20, "c2": 0.20, "c3": 0.30, "c4": 0.10, "c5": 0.20},
    # Методы входят в C2 отдельным, меньшим весом (ТЗ п. 5, строка C2).
    "method_weight": 0.3,
    "match_weights": {"name": 0.5, "attr": 0.3, "ctx": 0.2},
    "thresholds": {
        "accept": 0.85,
        "reject": 0.55,
        "match_min": 0.5,
        "name_min": 0.6,
        "member_min": 0.7,
        # ТЗ п. 7.2 и 7.3: при каком сходстве содержимого подозревать
        # слияние/расщепление классов и перенос атрибутов.
        "merge_min": 0.5,
        "absorb_min": 0.5,
    },
    "partial_credit": {
        "relation_kind_mismatch": 0.5,
        "relation_inversion": 0.25,
        # Кратность указана с одной стороны и не указана с другой: ни
        # совпадение, ни расхождение.
        "mult_missing": 0.5,
    },
    "extra_classes_max": 0.30,
    "check_visibility": False,
    "check_types": False,
    # ТЗ п. 4.3: транзитивное совпадение учитывается предупреждением и
    # включается флагом.
    "transitive_relations": True,
    # ТЗ п. 6.6(б): при таком разрыве между эталонами с разными вердиктами
    # работа уходит преподавателю.
    "ref_gap_min": 0.03,
}


class ConfigError(Exception):
    pass


@dataclass
class Config:
    task_id: str = ""
    refs: List[str] = field(default_factory=list)
    language: str = "ru"
    synonyms_raw: Dict[str, List[str]] = field(default_factory=dict)
    required_classes: List[str] = field(default_factory=list)
    required_relations: List[List[str]] = field(default_factory=list)
    weights: Dict[str, float] = field(default_factory=dict)
    method_weight: float = 0.3
    match_weights: Dict[str, float] = field(default_factory=dict)
    thresholds: Dict[str, float] = field(default_factory=dict)
    partial_credit: Dict[str, float] = field(default_factory=dict)
    extra_classes_max: float = 0.30
    check_visibility: bool = False
    check_types: bool = False
    transitive_relations: bool = True
    ref_gap_min: float = 0.03
    base_dir: str = "."
    synonyms: Synonyms = field(default_factory=Synonyms)
    data: Dict[str, Any] = field(default_factory=dict)

    # --- удобные обёртки -------------------------------------------------
    @property
    def accept(self) -> float:
        return float(self.thresholds["accept"])

    @property
    def reject(self) -> float:
        return float(self.thresholds["reject"])

    @property
    def match_min(self) -> float:
        return float(self.thresholds["match_min"])

    @property
    def name_min(self) -> float:
        return float(self.thresholds["name_min"])

    @property
    def member_min(self) -> float:
        return float(self.thresholds["member_min"])

    def ref_paths(self) -> List[str]:
        return [
            path if os.path.isabs(path) else os.path.join(self.base_dir, path)
            for path in self.refs
        ]

    def config_hash(self, ref_sources: Optional[Sequence[str]] = None) -> str:
        """Хеш конфигурации вместе с текстами эталонов (ТЗ п. 10.6).

        Пути в хеш не входят: один и тот же набор эталонов, лежащий в другом
        каталоге, должен давать тот же хеш.
        """
        payload = {
            key: value for key, value in sorted(self.data.items()) if key != "refs"
        }
        payload["refs"] = [
            hashlib.sha256((source or "").encode("utf-8")).hexdigest()
            for source in (ref_sources or [])
        ]
        canonical = json.dumps(
            payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _merge(defaults: Any, given: Any, where: str) -> Any:
    if isinstance(defaults, dict):
        if given is None:
            return dict(defaults)
        if not isinstance(given, dict):
            raise ConfigError(f"{where}: ожидается набор полей")
        merged = dict(defaults)
        for key, value in given.items():
            if key in defaults and isinstance(defaults[key], dict):
                merged[key] = _merge(defaults[key], value, f"{where}.{key}")
            else:
                merged[key] = value
        return merged
    return defaults if given is None else given


def _numbers(
    section: Dict[str, Any], where: str, low: float, high: float
) -> Dict[str, float]:
    out = {}
    for key, value in section.items():
        try:
            number = float(value)
        except (TypeError, ValueError):
            raise ConfigError(f"{where}.{key}: ожидается число, получено {value!r}")
        if not low <= number <= high:
            raise ConfigError(
                f"{where}.{key}: значение {number} вне диапазона [{low}, {high}]"
            )
        out[key] = number
    return out


def load_config_data(data: Optional[Dict[str, Any]], base_dir: str = ".") -> Config:
    """Собрать Config из разобранного YAML/JSON (или из пустоты: одни значения по умолчанию)."""
    if data is None:
        data = {}
    if not isinstance(data, dict):
        raise ConfigError("Конфигурация задания должна быть набором полей")

    unknown = sorted(set(data) - set(DEFAULTS))
    merged = _merge(DEFAULTS, data, "config")

    weights = _numbers(merged["weights"], "weights", 0.0, 1.0)
    for key in ("c1", "c2", "c3", "c4", "c5"):
        weights.setdefault(key, DEFAULTS["weights"][key])
    total = sum(weights[key] for key in ("c1", "c2", "c3", "c4", "c5"))
    if abs(total - 1.0) > 1e-6:
        raise ConfigError(
            f"weights: сумма весов C1..C5 должна быть 1.0, получено {total:.6f}"
        )

    match_weights = _numbers(merged["match_weights"], "match_weights", 0.0, 1.0)
    match_total = sum(match_weights.get(key, 0.0) for key in ("name", "attr", "ctx"))
    if abs(match_total - 1.0) > 1e-6:
        raise ConfigError(
            f"match_weights: сумма весов должна быть 1.0, получено {match_total:.6f}"
        )

    thresholds = _numbers(merged["thresholds"], "thresholds", 0.0, 1.0)
    if thresholds["reject"] > thresholds["accept"]:
        raise ConfigError("thresholds: reject не может быть больше accept")

    partial = _numbers(merged["partial_credit"], "partial_credit", 0.0, 1.0)

    synonyms_raw: Dict[str, List[str]] = {}
    for key, values in (merged.get("synonyms") or {}).items():
        if isinstance(values, str):
            values = [values]
        if values is None:
            values = []
        if not isinstance(values, (list, tuple)):
            raise ConfigError(f"synonyms.{key}: ожидается список имён")
        synonyms_raw[str(key)] = [str(value) for value in values]

    required_relations: List[List[str]] = []
    for pair in merged.get("required_relations") or []:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ConfigError("required_relations: каждая запись - пара имён классов")
        required_relations.append([str(pair[0]), str(pair[1])])

    refs = merged.get("refs") or []
    if isinstance(refs, str):
        refs = [refs]
    refs = [str(ref) for ref in refs]

    config = Config(
        task_id=str(merged.get("task_id") or ""),
        refs=refs,
        language=str(merged.get("language") or "ru"),
        synonyms_raw=synonyms_raw,
        required_classes=[str(name) for name in merged.get("required_classes") or []],
        required_relations=required_relations,
        weights=weights,
        method_weight=float(merged.get("method_weight", DEFAULTS["method_weight"])),
        match_weights=match_weights,
        thresholds=thresholds,
        partial_credit=partial,
        extra_classes_max=float(merged.get("extra_classes_max", 0.30)),
        check_visibility=bool(merged.get("check_visibility", False)),
        check_types=bool(merged.get("check_types", False)),
        transitive_relations=bool(merged.get("transitive_relations", True)),
        ref_gap_min=float(merged.get("ref_gap_min", 0.03)),
        base_dir=base_dir,
        synonyms=Synonyms(synonyms_raw),
    )
    config.data = {
        "task_id": config.task_id,
        "language": config.language,
        "synonyms": {
            key: sorted(values) for key, values in sorted(synonyms_raw.items())
        },
        "required_classes": sorted(config.required_classes),
        "required_relations": sorted(config.required_relations),
        "weights": weights,
        "method_weight": config.method_weight,
        "match_weights": match_weights,
        "thresholds": thresholds,
        "partial_credit": partial,
        "extra_classes_max": config.extra_classes_max,
        "check_visibility": config.check_visibility,
        "check_types": config.check_types,
        "transitive_relations": config.transitive_relations,
        "ref_gap_min": config.ref_gap_min,
    }
    if unknown:
        config.data["unknown_keys"] = unknown
    return config


def load_config(path: str) -> Config:
    import yaml

    with open(path, "r", encoding="utf-8") as handle:
        data = yaml.safe_load(handle)
    return load_config_data(
        data, base_dir=os.path.dirname(os.path.abspath(path)) or "."
    )


def required_class_norms(config: Config) -> List[str]:
    return [norm_name(name) for name in config.required_classes]
