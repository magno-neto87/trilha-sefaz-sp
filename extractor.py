#!/usr/bin/env python3
"""Extract study notes and commented questions from a subject-folder tree."""

from __future__ import annotations

import argparse
import html
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

try:
    import pymupdf
except ImportError:
    pymupdf = None


QUESTION_MARKER = re.compile(
    r"(?:\|?[ \t]*(?:\*\*|__)?\bquest[aã]o(?:\*\*|__)?\s*\|?)(?:[ \t]*|<br\s*/?>)*(?:n[º°o]\s*)?\d{1,}|"
    r"(?:^|\n)[ \t]*(?:#{1,4}\s*quest[aã]o\b.*$|(?:\*\*|__)?\bquest[aã]o(?:\*\*|__)?\s*[:：]|\bquest[aã]o\s+adaptada\b|quest[aã]o\s*$)",
    re.I | re.M,
)
OPTION_MARKER = re.compile(
    r"^\s*(?:#{1,6}\s*)?(?:[-*]\s+)?(?:\*\*)?([A-E])(?:\*\*)?\s*[\)\].:-]\s*(.*)$",
    re.I | re.M,
)
ANSWER_MARKER = re.compile(
    r"(?i)(?:gabarito|resposta\s+correta|resposta)\s*[:：\-]\s*"
    r"(?:alternativa\s*)?[\[(]?\s*([A-E])(?:\s*[\])}.:\-]|\*{1,2}|(?=\s|$))"
)
SOLUTION_MARKER = re.compile(
    r"(?im)^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:solu[cç][aã]o|coment[aá]rio do professor)"
    r"(?:\*\*)?\s*[:：]?\s*(?:\*\*)?"
)
HEADING = re.compile(r"(?m)^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$")
CONTENT_HEADING = re.compile(
    r"(?im)^\s{0,3}#{1,6}\s+(?!.*(?:solu[cç][aã]o|coment[aá]rio do professor|gabarito))(.+)$"
)
PAGE_COUNTER = re.compile(r"^\s*\d{1,3}\s*/\s*\d{1,3}\s*$")
DOCUMENT_UPDATE = re.compile(
    r"(?i)\s*(?:\*\*|__)?\s*documento\s+última\s+vez\s+atualizado\s+em\s+"
    r"\d{1,2}/\d{1,2}/\d{4}(?:\s+às\s+\d{1,2}:\d{2})?\.?\s*(?:\*\*|__)?"
)
COURSE_METADATA = re.compile(r"(?i)\b(?:SEFAZ-SP|Auditor Fiscal)\b.*\bProf\.?")
INSTRUCTOR_CREDIT = re.compile(
    r"(?i)^Prof\.?\s+[A-ZÀ-Þ][\wÀ-ÿ.'’ -]*,\s*Prof\.?\s+[A-ZÀ-Þ][\wÀ-ÿ.'’ -]*$"
)
PDF_BRANDING = re.compile(
    r"(?i)\*\*[^*\n]*(?:SEFAZ-SP|Estrat[eé]gia\s+Concursos|\bProf\.)[^*\n]*\*\*"
)
EXAM_SOURCE = re.compile(
    r"(?i)^\s*(?:19|20)\d{2}\s+(?:FCC|ESAF|CESPE|CEBRASPE|VUNESP|FGV|AOCP|IBFC|QUADRIX|"
    r"CONSULPLAN|IADES|FADESP|FUNDATEC|CCV|EXCEL[EÊ]NCIA|INSTITUTO\s+EXCEL[EÊ]NCIA|CESGRANRIO|IDECAN|SELECON)\b.*$"
)
NUMBERED_BOLD_LINE = re.compile(
    r"(?i)^\s*(?:\*\*|__)\s*(\d{1,3}\.\s+.+?)\s*(?:\*\*|__)\s*$"
)
BRANDED_RUNNING_HEADER = re.compile(
    r"(?i)^\s*(?:>|&gt;)?\s*(?:\d+(?:\.\d+)*\s+)?(?:estrat[eé]gia\s*concursos|estrat[eé]giaconcursos)\b.*$"
)
TRUNCATED_RUNNING_HEADER = re.compile(
    r"(?i)^\s*(?:>|&gt;)?\s*(?:\*\*|__)?\s*\d{1,3}\.\s+[^*_\n]+\b(?:usuári|legislaç|administraç)\b[^*_\n]*(?:\*\*|__)?\s*$"
)
RUNNING_COURSE_HEADER = re.compile(
    r"(?i)^\s*(?:>|&gt;)?\s*(?:\*\*|__)?[^*_\n]*\b(?:SEFAZ-SP|Auditor Fiscal)\b.*\b\d{1,3}\s*/\s*\d{1,3}\b.*$"
)
QUESTION_INTRO = re.compile(
    r"(?im)^\s*(?:agora,?\s*)?(?:vamos\s+resolver\s+(?:algumas\s+)?questões|veja\s+como\s+(?:esse\s+assunto\s+|isso\s+)?(?:já\s+)?foi\s+cobrado|questões\s+comentadas|exercícios\s+de\s+fixação|vamos\s+praticar)\s*[:：.]?\s*$"
)
PREV_EXAM_LINE = re.compile(
    r"(?im)^\s*(?:[-*•]\s*)?(?:(?:19|20)\d{2}\b|banca\b|FCC|ESAF|CESPE|CEBRASPE|VUNESP|FGV|AOCP|IBFC|QUADRIX|CONSULPLAN|IADES|FADESP|FUNDATEC|CCV|EXCEL[EÊ]NCIA|CESGRANRIO|IDECAN|SELECON)\b"
)
BANK_MARKER = re.compile(
    r"(?im)(?:^\s*(?:\|+[ \t]*)?(?:(?:19|20)\d{2}\s*)?(?:\|+[ \t]*)?(?:banca(?:\s+examinadora)?\s*[:：\-]\s*)?)"
    r"\b(FCC|ESAF|CESPE|CEBRASPE|VUNESP|FGV|AOCP|IBFC|QUADRIX|CONSULPLAN|IADES|FADESP|FUNDATEC|CCV(?:\s+UFC)?|EXCEL[EÊ]NCIA|INSTITUTO\s+EXCEL[EÊ]NCIA|CESGRANRIO|IDECAN|SELECON)\b"
)
GENERIC_TOPIC = re.compile(
    r"(?i)^(?:(?:lista\s+de\s+)?quest[oõ]es?(?:\s+comentadas?)?|"
    r"exerc[ií]cios|gabarito(?:\s+comentado)?|solu[cç][aã]o(?:\s+comentada)?|"
    r"resolu[cç][aã]o(?:\s+comentada)?|coment[aá]rios?(?:\s+do\s+professor)?)$"
)
PROMOTIONAL_ACCESS = re.compile(
    r"(?i)\b(?:assista\s+(?:(?:ao|o)\s+)?v[ií]deo\s+pelo\s+app|"
    r"acesse\s+(?:o\s+)?pdf\s+pelo\s+app|"
    r"acesse\s+(?:a\s+)?plataforma\s+pelo\s+qr\s*code|"
    r"(?:ou\s+)?acesse\s+pelo\s+link|"
    r"escute\s+o\s+cast\s+pelo\s+app)\b"
)
URL_CONTINUATION = re.compile(
    r"(?i)^\s*(?:https?://|www\.|(?=[\w./%?&=:#~+-]*[-./?&=%])[\w./%?&=:#~+-]+$)"
)
LINK_PROMPT = re.compile(r"(?i)\b(?:ou\s+)?acesse\s+pelo\s+link\b")
PROMOTIONAL_URL = re.compile(r"(?i)concursos\.estrategia\.com/ldi/")


def stable_id(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:14]


def natural_sort_key(path: Path) -> list:
    """Ordena caminhos usando ordem natural: '10. Foo' vem após '2. Bar'."""
    def to_int_or_str(text: str):
        return int(text) if text.isdigit() else text.casefold()
    return [to_int_or_str(chunk) for chunk in re.split(r"(\d+)", path.name)]


def clean_title(path: Path) -> str:
    title = path.stem
    title = re.sub(r"_[0-9a-f]{6,}$", "", title, flags=re.I)
    title = re.sub(r"^\s*\d+[.)-]\s*", "", title)
    return title.replace("_", " ").strip()


def normalize_answer(value: str) -> str | None:
    matches = list(ANSWER_MARKER.finditer(value))
    if not matches:
        matches = list(re.finditer(
            r"(?im)^\s*(?:\*\*)?gabarito(?:\*\*)?\s*[:：\-]\s*([A-E])\b", value
        ))
    return matches[-1].group(1).upper() if matches else None


def is_question_candidate(block: str) -> bool:
    block = normalize_question_layout(clean_pdf_artifacts(block))
    options = parse_options(block)
    if len(options) < 2:
        return False
    # Exige sequencia contigua de opcoes A-E em ordem crescente (A,B ou A,B,C etc.)
    keys = [o["key"] for o in options]
    expected = ["A", "B", "C", "D", "E"]
    for start in range(len(expected) - 1):
        seq = expected[start : start + len(keys)]
        if keys == seq[: len(keys)]:
            return True
    return False


def parse_options(block: str) -> list[dict[str, str]]:
    boundaries = [match.start() for match in (SOLUTION_MARKER.search(block),) if match]
    answer_matches = list(ANSWER_MARKER.finditer(block))
    if answer_matches:
        boundaries.append(answer_matches[-1].start())
    if boundaries:
        block = block[:min(boundaries)]
    raw_options: list[dict[str, str]] = []
    current: dict[str, str] | None = None
    previous_blank = False
    for line in block.splitlines():
        match = OPTION_MARKER.match(line)
        if match:
            current = {"key": match.group(1).upper(), "text": match.group(2).strip()}
            raw_options.append(current)
            previous_blank = False
        elif not line.strip():
            if current and current["text"]:
                previous_blank = True
        elif current and (not previous_blank or not current["text"]):
            if not re.search(
                r"(?i)(?:\d+/\d+|Estrat[eé]gia\s+Concursos|^#{1,6}\s)",
                line,
            ):
                current["text"] = f"{current['text']} {line.strip()}".strip()
                previous_blank = False
            else:
                current = None
        else:
            current = None

    valid_options: list[dict[str, str]] = []
    expected_order = {"A": 0, "B": 1, "C": 2, "D": 3, "E": 4}
    last_idx = -1
    for opt in raw_options:
        idx = expected_order.get(opt["key"], -1)
        if idx > last_idx:
            valid_options.append(opt)
            last_idx = idx
        elif valid_options:
            suffix = f" {opt['key']}) {opt['text']}".strip()
            valid_options[-1]["text"] = f"{valid_options[-1]['text']} {suffix}".strip()

    for opt in valid_options:
        opt["text"] = re.sub(r"\s*-\s*$", "", opt["text"]).strip()
        opt["text"] = re.sub(
            r"\s*(?:\*{1,2}|_{1,2})?\s*(?:solu[cç][aã]o|gabarito|coment[aá]rio)\s*[:：]?\s*(?:\*{1,2}|_{1,2})?.*$",
            "",
            opt["text"],
            flags=re.I,
        ).strip()

    return valid_options


def normalize_question_layout(block: str) -> str:
    block = re.sub(r"(?i)<br\s*/?>", "\n", block)
    block = re.sub(
        r"(?im)^\s*(?:#{1,6}\s*)?(?:[-*]\s+)?(?:\*\*)?([A-E])(?:\*\*)?\s*[\)\].:-]\s*\n+\s*(?:[-*]\s+)?",
        r"- \1) ",
        block,
    )
    block = re.sub(
        r"(?m)(?<!^)(?<!\n)[ \t]+(?=(?:#{1,6}\s*)?(?:[-*]\s+)?(?:\*\*)?[A-E](?:\*\*)?\s*[\)\]:-]|(?:#{1,6}\s*|[-*]\s+)(?:\*\*)?[A-E](?:\*\*)?\s*[\)\].:-](?:\s|<|$))",
        "\n",
        block,
    )
    return re.sub(r"(?is)<sup>(.*?)</sup>", r"\1", block)


def remove_page_counters(block: str) -> str:
    lines = [
        line for line in block.splitlines()
        if not PAGE_COUNTER.fullmatch(re.sub(r"[*_`]", "", line).strip())
    ]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def clean_study_metadata(block: str) -> str:
    cleaned = []
    for line in block.splitlines():
        line = DOCUMENT_UPDATE.sub("", line).strip()
        plain = re.sub(r"[*_`#]", "", line).strip()
        if (
            COURSE_METADATA.search(plain)
            or INSTRUCTOR_CREDIT.fullmatch(plain)
        ):
            continue
        cleaned.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(cleaned)).strip()


def clean_content_artifacts(block: str) -> str:
    block = re.sub(r"(?m)^\s*[-*•]?\s*[\ufffd\uFFFD]\s*", "- ", block)
    block = re.sub(r"\s*[\ufffd\uFFFD]\s*", " → ", block)

    def fix_table_row_br(match: re.Match[str]) -> str:
        return re.sub(r"(?i)<br\s*/?>", " ", match.group(0))

    block = re.sub(r"(?m)^\|[^\n]+\|$", fix_table_row_br, block)
    block = re.sub(r"(?m)^(\d+(?:\.\d+)*\s+.+\|)$", r"|\1", block)

    lines = block.splitlines()
    numbered_headers: dict[str, int] = {}
    for line in lines:
        match = NUMBERED_BOLD_LINE.fullmatch(line)
        if match:
            title = re.sub(r"\s+", " ", match.group(1)).strip().casefold()
            numbered_headers[title] = numbered_headers.get(title, 0) + 1

    cleaned: list[str] = []
    for line in lines:
        stripped = line.strip()
        plain = re.sub(r"[*_`#>]", "", stripped).strip()
        markup_placeholder = (
            re.search(r"(?:<|&lt;)\/?(?:mark|u)(?:\s|>|&gt;)", stripped, re.I)
            and not re.sub(r"[#*_~`\s>]", "", re.sub(r"<[^>]*>|&lt;[^&]*?&gt;", "", stripped))
        )
        numbered_header = NUMBERED_BOLD_LINE.fullmatch(line)
        if (
            BRANDED_RUNNING_HEADER.match(stripped)
            or TRUNCATED_RUNNING_HEADER.match(stripped)
            or RUNNING_COURSE_HEADER.match(stripped)
            or re.fullmatch(r"(?i)[:：]?\s*<sup>Estrat[eé]gia</sup>\s*Concursos", stripped)
            or PAGE_COUNTER.fullmatch(plain)
            or markup_placeholder
            or (numbered_header and numbered_headers[
                re.sub(r"\s+", " ", numbered_header.group(1)).strip().casefold()
            ] > 1)
            or (
                re.fullmatch(r"(?i)(?:\*\*|__)?\s*Prof\.?\s+.+?(?:\*\*|__)?", stripped)
                and len(plain) < 140
            )
            or re.fullmatch(r"(?i)Estrat[eé]gia\s+\*\*\d{1,3}\.\s+.+?\*\*\s*Concursos", stripped)
        ):
            continue
        cleaned.append(line)
    result = "\n".join(cleaned)
    result = re.sub(r"<!--\s*(?:Start|End) of picture text\s*-->", "", result, flags=re.I)
    result = re.sub(r"<!--[\s\S]*?-->", "", result)
    result = re.sub(r"<br\s*/?>", " ", result, flags=re.I)
    result = re.sub(r"</?(?:sup|sub|mark|u)\b[^>]*>", "", result, flags=re.I)
    result = re.sub(r"(?im)^\s*(?:agora,?\s*)?(?:vamos\s+resolver\s+(?:algumas\s+)?questões|veja\s+como\s+(?:esse\s+assunto\s+|isso\s+)?(?:já\s+)?foi\s+cobrado|vamos\s+praticar)\s*[:：.]?\s*\n+(?=\s*#{1,6}\s+)", "", result)
    return re.sub(r"\n{3,}", "\n\n", result).strip()


def clean_pdf_artifacts(block: str) -> str:
    cleaned: list[str] = []
    skip_next_blank = False
    for line in block.splitlines():
        line = PDF_BRANDING.sub("", line).strip()
        plain = re.sub(r"[*_`]", "", line).strip()

        # Remover cabeçalhos/rodapés de apostilas Estratégia
        if (
            PAGE_COUNTER.fullmatch(plain)
            or BRANDED_RUNNING_HEADER.match(plain)
            or RUNNING_COURSE_HEADER.match(plain)
            or re.search(r"(?i)\bestr(?:até|at[eé])gia\s+concursos\b", plain)
        ):
            while cleaned and not cleaned[-1].strip():
                cleaned.pop()
            skip_next_blank = True
            continue

        # Remover fontes de banca isoladas que não estão dentro de um bloco de questão
        if EXAM_SOURCE.fullmatch(plain) and not QUESTION_MARKER.search(plain):
            while cleaned and not cleaned[-1].strip():
                cleaned.pop()
            skip_next_blank = True
            continue

        # Remover cabeçalhos numerados em negrito repetidos (artefatos de slide)
        if re.fullmatch(r"(?i)(?:\*\*|__)?\s*\d{1,3}\.\s+.{12,}\s*(?:\*\*|__)?", plain) and line.startswith(("**", "__")):
            while cleaned and not cleaned[-1].strip():
                cleaned.pop()
            skip_next_blank = True
            continue

        if skip_next_blank and not line:
            continue
        skip_next_blank = False
        cleaned.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(cleaned)).strip()


def clean_promotional_content(markdown: str) -> str:
    markdown = re.sub(r"(?im)(?<!\|)<br\s*/?>(?!\|)", "\n", markdown)
    markdown = re.sub(r"(?i)<br\s*/?>", " ", markdown)
    lines = markdown.splitlines()
    cleaned: list[str] = []
    expecting_url = False
    continuing_url = False
    for line in lines:
        stripped = line.strip()
        if PROMOTIONAL_URL.search(stripped):
            if cleaned and re.fullmatch(r"\|?\s*htt(?:i|p|ps)?\s*\|?", cleaned[-1].strip(), re.I):
                cleaned.pop()
            continuing_url = True
            continue
        if PROMOTIONAL_ACCESS.search(stripped):
            expecting_url = bool(LINK_PROMPT.search(stripped))
            continuing_url = expecting_url and bool(re.search(r"(?i)https?://|www\.", stripped))
            continue
        if expecting_url:
            if not stripped:
                continue
            if re.match(r"(?i)^(?:https?://|www\.)", stripped):
                expecting_url = False
                continuing_url = True
                continue
            expecting_url = False
        if continuing_url:
            if not stripped:
                continuing_url = False
                continue
            url_fragment = stripped.strip("|").strip()
            if URL_CONTINUATION.fullmatch(url_fragment):
                continue
            continuing_url = False
        cleaned.append(line)
    return re.sub(r"\n{3,}", "\n\n", "\n".join(cleaned)).strip()


def question_completeness(question: dict[str, Any]) -> int:
    return (
        len(question["statement"])
        + len(question["solution"])
        + sum(len(option["text"]) for option in question["options"])
        + len(question.get("topic", ""))
        + len(question.get("bank", ""))
    )


def question_from_block(
    block: str,
    relative_path: str,
    occurrence: int,
    topic: str = "",
    bank: str = "",
) -> dict[str, Any]:
    block = clean_pdf_artifacts(normalize_question_layout(block))
    match = QUESTION_MARKER.search(block)
    raw_num = (
        re.sub(r"\s+", " ", re.sub(r"[|*_`#]", "", match.group(0))).strip()
        if match else f"Questão {occurrence}"
    )
    num_match = re.search(r"\b(?:n[º°o]\s*)?(\d+)\b", raw_num)
    if num_match:
        question_number = f"Questão {num_match.group(1)}"
    else:
        ext_match = re.search(r"\b\d{6,}\b", block)
        if ext_match:
            question_number = f"Questão {ext_match.group(0)}"
        else:
            question_number = f"Questão {occurrence}"
    options = parse_options(block)
    solution_match = SOLUTION_MARKER.search(block)
    solution = block[solution_match.end():].strip() if solution_match else ""
    nested_q = QUESTION_MARKER.search(solution)
    if nested_q:
        solution = solution[:nested_q.start()].strip()
    # Remove repeated answer lines from the displayed explanation, not from its source.
    solution = re.sub(
        r"(?im)^\s*(?:\*\*)?(?:gabarito|resposta correta)\s*[:：\-].*$",
        "",
        solution,
    ).strip()
    stem = block[:solution_match.start()] if solution_match else block
    option_match = OPTION_MARKER.search(stem)
    if option_match:
        stem = stem[:option_match.start()]
    stem = re.sub(QUESTION_MARKER, "", stem, count=1).strip()
    stem = re.sub(r"(?im)^\s*\|[^\n]+\|\s*$", "", stem).strip()
    stem = re.sub(r"(?im)^\s*[-*•]?\s*(?:19|20)\d{2}\s+.*$", "", stem).strip()
    stem = re.sub(r"(?m)^\s*(?:[-*_]\s*){3,}$", "", stem).strip()
    answer = normalize_answer(block)
    if answer and options and answer not in {option["key"] for option in options}:
        answer = None
    key = f"{relative_path}:{occurrence}:{question_number}"
    return {
        "id": stable_id(key),
        "number": question_number,
        "statement": stem,
        "options": options,
        "answer": answer,
        "solution": solution,
        "source": relative_path,
        "topic": topic,
        "bank": bank,
    }


def find_question_start(markdown: str, match_start: int) -> int:
    line_start = markdown.rfind("\n", 0, match_start) + 1
    cursor = line_start
    candidate_start = line_start
    while cursor > 0:
        prev_newline = markdown.rfind("\n", 0, cursor - 1)
        prev_line = markdown[prev_newline + 1:cursor - 1].strip()
        if not prev_line:
            cursor = prev_newline + 1 if prev_newline >= 0 else 0
            continue
        is_exam = bool(
            EXAM_SOURCE.match(prev_line)
            or PREV_EXAM_LINE.match(prev_line)
            or BANK_MARKER.match(prev_line)
            or (prev_line.startswith("|") and ("19" in prev_line or "20" in prev_line or "---" in prev_line or "banca" in prev_line.casefold() or "ufc" in prev_line.casefold()))
        )
        if is_exam:
            cursor = prev_newline + 1 if prev_newline >= 0 else 0
            candidate_start = cursor
        else:
            break
    return candidate_start


def extract_questions(markdown: str, relative_path: str) -> tuple[str, list[dict[str, Any]]]:
    matches = list(QUESTION_MARKER.finditer(markdown))
    if not matches:
        return clean_content_artifacts(clean_study_metadata(remove_page_counters(markdown))), []

    starts: list[int] = []
    for index, match in enumerate(matches):
        start = find_question_start(markdown, match.start())
        if starts and start <= starts[-1]:
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        candidate = markdown[start:end]
        if not is_question_candidate(candidate):
            continue
        starts.append(start)

    questions: list[dict[str, Any]] = []
    if not starts:
        return clean_content_artifacts(clean_study_metadata(remove_page_counters(markdown))), []

    first_theory = markdown[:starts[0]]
    first_theory = re.sub(
        r"(?im)\n\s*(?:agora,?\s*)?(?:vamos\s+resolver\s+(?:algumas\s+)?questões|veja\s+como\s+(?:esse\s+assunto\s+|isso\s+)?(?:já\s+)?foi\s+cobrado|questões\s+comentadas|exercícios\s+de\s+fixação|vamos\s+praticar)\s*[:：.]?\s*$",
        "",
        first_theory,
    )
    theory_parts = [first_theory]
    headings = list(HEADING.finditer(markdown))
    heading_index = 0
    topic = ""
    for index, start in enumerate(starts):
        while heading_index < len(headings) and headings[heading_index].start() < start:
            candidate = re.sub(r"[*_`]", "", headings[heading_index].group(2)).strip().rstrip(":：").strip()
            if candidate and not GENERIC_TOPIC.fullmatch(candidate):
                topic = candidate
            heading_index += 1
        end = starts[index + 1] if index + 1 < len(starts) else len(markdown)
        segment = markdown[start:end]
        answer_matches = list(ANSWER_MARKER.finditer(segment))
        solution_match = SOLUTION_MARKER.search(segment)
        final_answers = [match for match in answer_matches if solution_match and match.start() > solution_match.end()]
        final_answer = final_answers[-1] if len(final_answers) > 1 else None
        answer_to_end = final_answer or (answer_matches[-1] if not solution_match and answer_matches else None)
        if answer_to_end:
            line_end = segment.find("\n", answer_to_end.end())
            question_end = len(segment) if line_end < 0 else line_end
        elif solution_match:
            next_heading = CONTENT_HEADING.search(segment, solution_match.end())
            question_end = next_heading.start() if next_heading else len(segment)
        else:
            question_end = len(segment)
        block = segment[:question_end].strip()
        theory_tail = segment[question_end:]
        if not block:
            theory_parts.append(theory_tail)
            continue
        if index > 0:
            previous_start = starts[index - 1]
            previous_segment = markdown[previous_start:start]
            previous_solution = SOLUTION_MARKER.search(previous_segment)
            if previous_solution:
                between = markdown[previous_start + previous_solution.start():start]
                if len(between.strip()) < 400 and not re.search(r"\n\s*\n", between):
                    continue
        bank_match = BANK_MARKER.search(block)
        parsed = question_from_block(
            block,
            relative_path,
            len(questions) + 1,
            topic=topic,
            bank=bank_match.group(1).upper() if bank_match else "",
        )
        if parsed["statement"] or parsed["options"]:
            questions.append(parsed)
        theory_tail = re.sub(
            r"(?im)^\s*(?:agora,?\s*)?(?:vamos\s+resolver\s+(?:algumas\s+)?questões|veja\s+como\s+(?:esse\s+assunto\s+|isso\s+)?(?:já\s+)?foi\s+cobrado|questões\s+comentadas|exercícios\s+de\s+fixação|vamos\s+praticar)\s*[:：.]?\s*\n+",
            "",
            theory_tail,
        )
        theory_parts.append(theory_tail)
    theory = clean_content_artifacts(clean_study_metadata(
        remove_page_counters("\n".join(part.strip() for part in theory_parts if part.strip()))
    ))
    unique_questions: list[dict[str, Any]] = []
    question_positions: dict[str, int] = {}
    for question in questions:
        external_id = re.search(r"\d{6,}", question["number"])
        if not external_id:
            unique_questions.append(question)
            continue
        key = external_id.group(0)
        previous_index = question_positions.get(key)
        if previous_index is None:
            question_positions[key] = len(unique_questions)
            unique_questions.append(question)
            continue
        previous = unique_questions[previous_index]
        if question_completeness(question) > question_completeness(previous):
            unique_questions[previous_index] = question
    return theory, unique_questions


def deduplicate_subject_questions(materials: list[dict[str, Any]]) -> None:
    selected: list[tuple[int, dict[str, Any]]] = []
    positions: dict[str, int] = {}
    for material_index, material in enumerate(materials):
        for question in material["questions"]:
            external_id = re.search(r"\d{6,}", question["number"])
            if not external_id:
                selected.append((material_index, question))
                continue
            key = external_id.group(0)
            position = positions.get(key)
            if position is None:
                positions[key] = len(selected)
                selected.append((material_index, question))
            elif question_completeness(question) > question_completeness(selected[position][1]):
                selected[position] = (material_index, question)

    for material in materials:
        material["questions"] = []
    for material_index, question in selected:
        materials[material_index]["questions"].append(question)


def generate_flashcards(markdown: str, source: str) -> list[dict[str, str]]:
    cards: list[dict[str, str]] = []
    matches = list(HEADING.finditer(markdown))
    for index, heading in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(markdown)
        section = markdown[heading.end():end]
        front = html.unescape(re.sub(r"<[^>]+>", " ", heading.group(2)))
        front = re.sub(r"[*_`]", " ", front)
        front = re.sub(r"\s+", " ", front).strip()
        if (
            len(front) < 8
            or re.fullmatch(r"[\d./\s-]+", front)
            or re.search(r"(?i)\bestrat[eé]gia\s*concursos\b", front)
            or re.search(r"(?i)\b(?:apresenta[cç][aã]o|sum[aá]rio|conte[uú]do program[aá]tico)\b", front)
            or re.fullmatch(r"(?i)(?:conte[uú]do|introdu[cç][aã]o|começando)", front)
            or re.search(r"(?i)(?:SEFAZ-SP|Auditor Fiscal|Prof\.)", front)
        ):
            continue
        paragraph = ""
        section = re.sub(r"<!--.*?-->", "", section, flags=re.S)
        for candidate in re.split(r"\n\s*\n", section):
            candidate = re.sub(r"(?im)^\s*Documento\s+última\s+vez\s+atualizado[^\n]*", "", candidate)
            candidate = re.sub(r"(?im)^\s*\*\*.*(?:SEFAZ-SP|Estrat[eé]gia|Concursos).*\*\*\s*$", "", candidate)
            candidate = re.sub(r"(?im)^\s*Estrat[eé]gia.*$", "", candidate)
            candidate = re.sub(r"<[^>]+>", " ", candidate)
            candidate = html.unescape(candidate)
            candidate = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", candidate)
            candidate = re.sub(r"\[[^\]]+\]\([^)]*\)", "", candidate)
            candidate = re.sub(r"[*_`>#|]", " ", candidate)
            candidate = re.sub(r"(?i)\bestrat[eé]gia\s*concursos\b", " ", candidate)
            candidate = re.sub(r"(?m)^\s*\d+(?:/\d+)?\s*", "", candidate)
            candidate = re.sub(r"\s+", " ", candidate).strip()
            if (
                len(candidate) >= 40
                and not re.search(
                    r"(?i)(?:https?://|QR\s*code|escute o cast|acesse a plataforma|documento última vez|"
                    r"quem conhece os cursos do estratégia|livros digitais em pdf|vídeos completos|"
                    r"prof\. equipe contabilidade)",
                    candidate,
                )
                and len(re.findall(r"\.{4,}", candidate)) < 2
            ):
                paragraph = candidate
                break
        if len(paragraph) < 40:
            continue
        cards.append({
            "id": stable_id(f"{source}:{heading.group(2)}"),
            "front": front,
            "back": paragraph[:500].rstrip(),
            "source": source,
        })
    return cards


def extract_pdf_to_markdown(pdf_path: Path) -> str:
    """Extract clean markdown-like text from a PDF file using PyMuPDF."""
    if pymupdf is None:
        raise RuntimeError("Para processar arquivos PDF, instale o pacote pymupdf: pip install pymupdf")
    doc = pymupdf.open(pdf_path)
    output_lines: list[str] = []

    for page in doc:
        rect = page.rect
        # Margens mais generosas para cortar cabeçalhos/rodapés de slides
        header_limit = rect.y0 + 50
        footer_limit = rect.y1 - 40
        page_width = rect.x1 - rect.x0
        d = page.get_text("dict")
        blocks = d.get("blocks", [])

        # Apenas blocos de texto dentro das margens seguras
        valid_blocks = [
            b for b in blocks
            if b.get("type") == 0
            and b["bbox"][1] >= header_limit
            and b["bbox"][3] <= footer_limit
        ]
        # Ordenar por faixa vertical (bucket de 10pt) e depois por posição horizontal
        valid_blocks.sort(key=lambda b: (round(b["bbox"][1] / 10) * 10, b["bbox"][0]))

        # Detectar layout de duas colunas: se bloco central X > 55% da largura
        def is_right_column(b: dict) -> bool:
            left_x = b["bbox"][0] - rect.x0
            return left_x > page_width * 0.52

        for b in valid_blocks:
            block_lines: list[str] = []
            for ln in b.get("lines", []):
                spans = ln.get("spans", [])
                if not spans:
                    continue
                line_text = "".join(s["text"] for s in spans).strip()
                if not line_text:
                    continue

                # Remover linhas de sumário (leader dots)
                if len(re.findall(r"\.{4,}", line_text)) >= 1:
                    continue

                # Remover cabeçalhos/rodapés comuns de apostilas
                if (
                    PAGE_COUNTER.fullmatch(line_text)
                    or COURSE_METADATA.search(line_text)
                    or DOCUMENT_UPDATE.search(line_text)
                    or BRANDED_RUNNING_HEADER.match(line_text)
                    or RUNNING_COURSE_HEADER.match(line_text)
                ):
                    continue

                # Remover linhas de promoção/branding
                plain_text = re.sub(r"[*_`#]", "", line_text).strip()
                if re.search(r"(?i)\bestr(?:até|at[eé])gia\s+concursos\b", plain_text):
                    continue
                if re.fullmatch(r"(?i)prof\.?\s+[\w\s.,''-]+", plain_text) and len(plain_text) < 80:
                    continue

                max_size = max(s["size"] for s in spans)
                is_bold = any("bold" in s["font"].lower() or s["flags"] & 2 for s in spans)

                # Heurística de heading: número de seção ou tamanho grande
                is_section_num = bool(re.match(r"^\d+(?:\.\d+)+\s+[A-ZÀ-Ú]", line_text))

                if max_size >= 20:
                    line_formatted = f"# {line_text}"
                elif max_size >= 15 or is_section_num:
                    line_formatted = f"## {line_text}"
                elif is_bold and len(line_text) < 100 and re.search(r"[:：]$", line_text):
                    line_formatted = f"### {line_text}"
                elif is_bold and re.match(
                    r"(?i)^(?:questão|gabarito|solu[cç][aã]o|coment[aá]rio)\b",
                    line_text,
                ):
                    line_formatted = f"**{line_text}**"
                else:
                    line_formatted = line_text
                block_lines.append(line_formatted)

            if block_lines:
                output_lines.append("\n".join(block_lines))

    text = "\n\n".join(output_lines)

    # Pós-processamento: separar alternativas coladas (A)texto B)texto → linhas separadas
    text = re.sub(
        r"(?<!\n)(?=\s+(?:[B-E])\s*[\)\.]\s+\S)",
        "\n",
        text,
    )
    # Garantir que cada alternativa comece em nova linha
    text = re.sub(
        r"(?m)([^\n])(\s+)([A-E])\s*[\)\.]\s+",
        lambda m: f"{m.group(1)}\n{m.group(3)}) ",
        text,
    )
    # Remover múltiplas linhas em branco consecutivas
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract(root: Path, output: Path, source_format: str = "auto") -> dict[str, Any]:
    root = root.resolve()
    if not root.is_dir():
        raise FileNotFoundError(f"Pasta de origem não encontrada: {root}")
    subject_dirs = sorted((path for path in root.iterdir() if path.is_dir()), key=natural_sort_key)
    subjects: list[dict[str, Any]] = []
    manifest_materials: list[dict[str, str]] = []
    question_index: list[dict[str, str]] = []
    total_questions = 0
    total_cards = 0

    for subject_dir in subject_dirs:
        materials: list[dict[str, Any]] = []
        if source_format == "pdf":
            source_files = sorted(subject_dir.rglob("*.pdf"), key=natural_sort_key)
        elif source_format == "md":
            source_files = sorted(subject_dir.rglob("*.md"), key=natural_sort_key)
        else:  # auto: prefer pdf if available in subject_dir, else md
            source_files = sorted(subject_dir.rglob("*.pdf"), key=natural_sort_key)
            if not source_files:
                source_files = sorted(subject_dir.rglob("*.md"), key=natural_sort_key)
        if not source_files:
            continue
        for source in source_files:
            relative = source.relative_to(root).as_posix()
            canonical_relative = source.with_suffix(".md").relative_to(root).as_posix()
            if source.suffix.lower() == ".pdf":
                markdown = extract_pdf_to_markdown(source)
            else:
                markdown = source.read_text(encoding="utf-8-sig", errors="replace")
            theory, questions = extract_questions(markdown, relative)
            theory = clean_promotional_content(theory)
            title = clean_title(source)
            cards = generate_flashcards(theory, relative)
            material = {
                "id": stable_id(canonical_relative),
                "title": title,
                "source": relative,
                "content": theory,
                "questions": questions,
                "flashcards": cards,
            }
            materials.append(material)
            manifest_materials.append({
                "id": material["id"],
                "subject": subject_dir.name,
                "title": title,
            })
            total_cards += len(cards)

        deduplicate_subject_questions(materials)
        total_questions += sum(len(item["questions"]) for item in materials)
        subject_id = stable_id(subject_dir.name)
        subject = {
            "id": subject_id,
            "name": subject_dir.name,
            "materials": len(materials),
            "questions": sum(len(item["questions"]) for item in materials),
            "flashcards": sum(len(item["flashcards"]) for item in materials),
            "file": f"subjects/{subject_id}.json",
        }
        subjects.append(subject)
        for material in materials:
            for question in material["questions"]:
                question_index.append({
                    "id": question["id"],
                    "subjectId": subject_id,
                    "topic": question.get("topic", ""),
                    "bank": question.get("bank", ""),
                })
        output_file = output / subject["file"]
        output_file.parent.mkdir(parents=True, exist_ok=True)
        output_file.write_text(
            json.dumps({"subject": subject, "materials": materials}, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

    manifest = {
        "generatedAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "subjects": subjects,
        "materials": manifest_materials,
        "questionIndexFile": "question-index.json",
        "totals": {
            "subjects": len(subjects),
            "materials": len(manifest_materials),
            "questions": total_questions,
            "flashcards": total_cards,
        },
    }
    output.mkdir(parents=True, exist_ok=True)
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    (output / "question-index.json").write_text(
        json.dumps({"questions": question_index}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "source",
        nargs="?",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="Pasta com uma subpasta por disciplina (padrão: pasta do script)",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(__file__).resolve().parent / "data",
        help="Pasta de saída dos arquivos JSON (padrão: ./data)",
    )
    parser.add_argument(
        "--format",
        choices=["auto", "pdf", "md"],
        default="pdf",
        help="Formato dos arquivos a processar: pdf (padrão), auto (prioriza PDF se disponível) ou md",
    )
    args = parser.parse_args()
    try:
        manifest = extract(args.source, args.output, source_format=args.format)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Erro ao extrair materiais: {error}", file=sys.stderr)
        return 1
    totals = manifest["totals"]
    print(
        f"Extração concluída: {totals['subjects']} disciplinas, "
        f"{totals['materials']} materiais, {totals['questions']} questões e "
        f"{totals['flashcards']} flashcards em {args.output.resolve()}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
