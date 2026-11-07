"""
Extract and build Derecho Tributário summaries from Resumo_tributario into data/resumos.json
"""
import hashlib
import json
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

def stable_id(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:14]

def parse_docx_elements(docx_path: Path):
    with zipfile.ZipFile(docx_path) as z:
        xml = z.read("word/document.xml")
    root = ET.fromstring(xml)
    body = root.find(f"{{{W_NS}}}body")
    if body is None:
        return []

    elements = []
    for child in body:
        tag = child.tag.replace(f"{{{W_NS}}}", "")
        if tag == 'p':
            pPr = child.find(f"{{{W_NS}}}pPr")
            pStyle = pPr.find(f"{{{W_NS}}}pStyle") if pPr is not None else None
            style_val = pStyle.get(f"{{{W_NS}}}val", "") if pStyle is not None else ""

            runs = []
            for r in child.findall(f"{{{W_NS}}}r"):
                rPr = r.find(f"{{{W_NS}}}rPr")
                is_b = rPr is not None and (rPr.find(f"{{{W_NS}}}b") is not None or rPr.find(f"{{{W_NS}}}bCs") is not None)
                is_i = rPr is not None and (rPr.find(f"{{{W_NS}}}i") is not None or rPr.find(f"{{{W_NS}}}iCs") is not None)
                r_text = "".join(t.text for t in r.findall(f"{{{W_NS}}}t") if t.text)
                if r_text:
                    if is_b and is_i:
                        formatted = f"***{r_text}***"
                    elif is_b:
                        formatted = f"**{r_text}**"
                    elif is_i:
                        formatted = f"*{r_text}*"
                    else:
                        formatted = r_text
                    runs.append(formatted)
            line = "".join(runs).strip()
            line = re.sub(r"\*\*\s+", "**", line)
            line = re.sub(r"\s+\*\*", "**", line)
            if line:
                elements.append(('p', line, style_val))
        elif tag == 'tbl':
            rows = []
            for tr in child.findall(f"{{{W_NS}}}tr"):
                row = []
                for tc in tr.findall(f"{{{W_NS}}}tc"):
                    cell_paras = []
                    for cp in tc.findall(f"{{{W_NS}}}p"):
                        c_runs = []
                        for cr in cp.findall(f"{{{W_NS}}}r"):
                            rPr = cr.find(f"{{{W_NS}}}rPr")
                            is_b = rPr is not None and (rPr.find(f"{{{W_NS}}}b") is not None or rPr.find(f"{{{W_NS}}}bCs") is not None)
                            t_val = "".join(ct.text for ct in cr.findall(f"{{{W_NS}}}t") if ct.text)
                            if t_val:
                                c_runs.append(f"**{t_val}**" if is_b else t_val)
                        cell_line = "".join(c_runs).strip()
                        if cell_line:
                            cell_paras.append(cell_line)
                    row.append("<br>".join(cell_paras))
                if row:
                    rows.append(row)
            if rows:
                elements.append(('tbl', rows, ""))
    return elements

def elements_to_markdown(elements) -> str:
    md_lines = []
    in_table = False
    
    for kind, data, style in elements:
        if kind == 'p':
            line = data.strip()
            plain = re.sub(r"[*_`#]", "", line).strip()
            
            # Skip promotional / course headers
            if re.search(r"(?i)\b(?:Prof\.?\s+[A-Z]|SEFAZ-SP\s*\([A-Za-z\s-]+\)\s*-\s*Prof\.)", plain):
                continue
            if re.fullmatch(r"(?i)(?:direito tribut[aá]rio\s*[-—–]?\s*resumo|resumo detalhado\s*[-—–]?\s*direito tribut[aá]rio)", plain):
                continue
            
            # Headings starting with Resumo or Tópico
            m_top = re.match(r"(?i)^(?:resumo\s*[-—–:]\s*t[oó]pico\s*(\d+(?:\.\d+)*)\s*[:—–-]?\s*|t[oó]pico\s*(\d+(?:\.\d+)*)\s*[:—–-]?\s*)(.+)$", plain)
            if m_top:
                num = m_top.group(1) or m_top.group(2)
                title = m_top.group(3).strip()
                md_lines.append(f"\n## {num} {title}\n")
                continue

            # Section headings: 1.1 ..., 1.2 ..., 1. ..., 2. ...
            m_sec = re.match(r"^(\d+(?:\.\d+)*)(?:[.)\-—–:]\s*|\s+)(.+)$", plain)
            if m_sec and len(plain) < 130 and not plain.endswith((".", ";")):
                num, title = m_sec.groups()
                title = title.lstrip("-—–: ").strip()
                level = min(4, num.count(".") + 2)
                md_lines.append(f"\n{'#' * level} {num}. {title}\n")
                continue
                
            # Single word / short all caps heading or important bold headings
            if (line.startswith("**") and line.endswith("**") and len(plain) < 70 and not plain.endswith((".", ":", ";"))):
                if re.match(r"^\d+", plain):
                    md_lines.append(f"\n## {plain}\n")
                else:
                    md_lines.append(f"\n### {plain}\n")
                continue

            # Standard line
            md_lines.append(line)
        elif kind == 'tbl':
            rows = data
            if not rows:
                continue
            # Build markdown table
            header = rows[0]
            header_line = "| " + " | ".join(header) + " |"
            sep_line = "| " + " | ".join(["---"] * len(header)) + " |"
            md_lines.append("\n" + header_line)
            md_lines.append(sep_line)
            for row in rows[1:]:
                # Normalize cell count
                if len(row) < len(header):
                    row = row + [""] * (len(header) - len(row))
                elif len(row) > len(header):
                    row = row[:len(header)]
                md_lines.append("| " + " | ".join(row) + " |")
            md_lines.append("\n")

    text = "\n\n".join(md_lines)
    # Cleanup extra blanks
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text

def estimate_read_time(text: str) -> int:
    words = len(re.findall(r"\w+", text))
    return max(3, round(words / 160))

def build_all_resumos(resumo_dir: Path, output_path: Path):
    resumo_dir = resumo_dir.resolve()
    combo_file = resumo_dir / "RESUMO - DIREITO TRIBUTÁRIO 7 a 21.docx"
    combo_elems = parse_docx_elements(combo_file)

    # Split combo elements into sections
    # Slices determined from inspection:
    # Elem [315]: Aula 12 - Administração Tributária (CTN)
    # Elem [402]: Aula 13 - Impostos da União
    # Elem [538]: Aula 14 - Impostos dos Estados e do DF
    # Elem [707]: Aula 15 - Impostos dos Municípios
    # Elem [869]: Aula 16 - Imposto Sobre Bens e Serviços (IBS)
    # Elem [947]: Aula 17 - Contribuição sobre Bens e Serviços (CBS)
    # Elem [1045]: Aula 18 - Repartição das Receitas Tributárias
    # Elem [1141]: Aula 20 - Simples Nacional - Parte 1
    # Elem [1274]: Aula 21 - Simples Nacional - Parte 2

    # Map of all 21 items
    items_meta = [
        {
            "num": 1,
            "title": "Aula 01 - Tributo: Conceito, Natureza Jurídica e Espécies",
            "subtitle": "Noções introdutórias, impostos, taxas, contribuições de melhoria, empréstimos compulsórios e contribuições especiais",
            "source_type": "file",
            "file": "Resumo_1_Tributo_Direito_Tributario.docx",
            "tags": ["Tributos", "Espécies Tributárias", "CTN art. 3º a 19", "CF/88"],
        },
        {
            "num": 2,
            "title": "Aula 02 - Princípios e Limitações Constitucionais ao Poder de Tributar",
            "subtitle": "Legalidade, isonomia, irretroatividade, anterioridade anual e nonagesimal, não confisco e liberdade de tráfego",
            "source_type": "file",
            "file": "Resumo_2_Principios_Limitacoes_Poder_Tributar.docx",
            "tags": ["Princípios", "Legalidade", "Anterioridade", "CF art. 150"],
        },
        {
            "num": 3,
            "title": "Aula 03 - Imunidades Tributárias",
            "subtitle": "Distinção entre imunidade, isenção e não incidência. Imunidade recíproca, templos, partidos, livros/papel e fonogramas",
            "source_type": "file",
            "file": "Resumo_3_Imunidade_Tributaria.docx",
            "tags": ["Imunidade", "CF art. 150 VI", "Isenção", "Jurisprudência STF"],
        },
        {
            "num": 4,
            "title": "Aula 04 - Competência Tributária",
            "subtitle": "Características, indelegabilidade, capacidade ativa, bitributação, bis in idem e distribuição constitucional",
            "source_type": "file",
            "file": "Resumo_4_Competencia_Tributaria.docx",
            "tags": ["Competência", "Indelegabilidade", "Capacidade Tributária", "CTN art. 6º a 8º"],
        },
        {
            "num": 5,
            "title": "Aula 05 - Fontes e Legislação Tributária",
            "subtitle": "Leis, tratados, decretos e normas complementares. Vigência, aplicação, interpretação e integração",
            "source_type": "file",
            "file": "Resumo_5_Fontes_do_Direito_Tributario.docx",
            "tags": ["Legislação", "Vigência", "Interpretação", "CTN art. 96 a 112"],
        },
        {
            "num": 6,
            "title": "Aula 06 - Obrigação Tributária",
            "subtitle": "Obrigação principal e acessória, fato gerador, sujeitos ativo e passivo, solidariedade e domicílio tributário",
            "source_type": "file",
            "file": "Resumo_6_Obrigacao_Tributaria.docx",
            "tags": ["Obrigação Tributária", "Fato Gerador", "Solidariedade", "CTN art. 113 a 127"],
        },
        {
            "num": 7,
            "title": "Aula 07 - Responsabilidade Tributária",
            "subtitle": "Responsabilidade dos sucessores, de terceiros, por substituição e responsabilidade por infrações",
            "source_type": "file",
            "file": "Resumo_7_Responsabilidade_Tributaria.docx",
            "tags": ["Responsabilidade", "Sucessores", "Terceiros", "CTN art. 128 a 138"],
        },
        {
            "num": 8,
            "title": "Aula 08 - Crédito Tributário e Lançamento",
            "subtitle": "Constituição do crédito, natureza do lançamento, alteração e modalidades (ofício, declaração e homologação)",
            "source_type": "file",
            "file": "Resumo_8_Credito_Tributario_Lancamento.docx",
            "tags": ["Crédito Tributário", "Lançamento", "Homologação", "CTN art. 139 a 150"],
        },
        {
            "num": 9,
            "title": "Aula 09 - Suspensão da Exigibilidade do Crédito Tributário",
            "subtitle": "Moratória, depósito integral, reclamações/recursos administrativos, liminares e parcelamento (Art. 151 CTN)",
            "source_type": "file",
            "file": "Resumo_9_Suspensao_Credito_Tributario.docx",
            "tags": ["Suspensão", "Moratória", "Parcelamento", "CTN art. 151"],
        },
        {
            "num": 10,
            "title": "Aula 10 - Extinção do Crédito Tributário",
            "subtitle": "Pagamento, compensação, transação, remissão, decadência, prescrição, consignação e dação em pagamento (Art. 156 CTN)",
            "source_type": "file",
            "file": "Resumo_10_Extincao_do_Credito_Tributario.docx",
            "tags": ["Extinção", "Decadência", "Prescrição", "Pagamento", "CTN art. 156"],
        },
        {
            "num": 11,
            "title": "Aula 11 - Exclusão do Crédito Tributário",
            "subtitle": "Isenção e anistia: conceitos, hipóteses de concessão, revogação e interpretação literal (Arts. 175 a 182 CTN)",
            "source_type": "file",
            "file": "Resumo_11_Exclusao_do_Credito_Tributario.docx",
            "tags": ["Exclusão", "Isenção", "Anistia", "CTN art. 175 a 182"],
        },
        {
            "num": 12,
            "title": "Aula 12 - Garantias e Privilégios do Crédito Tributário",
            "subtitle": "Universalidade da cobrança, presunção de fraude, indisponibilidade de bens, quitação e ordem na falência",
            "source_type": "file",
            "file": "Resumo_12_Garantias_e_Privilegios_do_Credito_Tributario_RESUMO_COMPLETO.docx",
            "tags": ["Garantias", "Privilégios", "Falência", "Fraude à Execução", "CTN art. 183 a 193"],
        },
        {
            "num": 13,
            "title": "Aula 13 - Administração Tributária (CTN)",
            "subtitle": "Fiscalização tributária, deveres dos servidores, sigilo fiscal, dívida ativa e certidões negativas (CND e CPEN)",
            "source_type": "combo",
            "slice": (315, 402),
            "tags": ["Administração Tributária", "Fiscalização", "Dívida Ativa", "Certidões", "CTN art. 194 a 208"],
        },
        {
            "num": 14,
            "title": "Aula 14 - Impostos da União",
            "subtitle": "II, IE, IR, IPI, IOF, ITR, IGF, impostos extraordinários de guerra e competência residual",
            "source_type": "combo",
            "slice": (402, 538),
            "tags": ["Impostos Federais", "IR", "IPI", "ITR", "IOF", "CF art. 153 e 154"],
        },
        {
            "num": 15,
            "title": "Aula 15 - Impostos dos Estados e do Distrito Federal",
            "subtitle": "ITCMD (regras da EC 132/23), ICMS (fato gerador, não cumulatividade, exportação, DIFAL) e IPVA",
            "source_type": "combo",
            "slice": (538, 707),
            "tags": ["Impostos Estaduais", "ICMS", "ITCMD", "IPVA", "CF art. 155"],
        },
        {
            "num": 16,
            "title": "Aula 16 - Impostos dos Municípios",
            "subtitle": "IPTU (progressividade, alíquotas), ITBI (fato gerador, imunidade societária) e ISSQN (LC 116/2003)",
            "source_type": "combo",
            "slice": (707, 869),
            "tags": ["Impostos Municipais", "IPTU", "ITBI", "ISSQN", "CF art. 156"],
        },
        {
            "num": 17,
            "title": "Aula 17 - Imposto Sobre Bens e Serviços (IBS)",
            "subtitle": "Reforma Tributária (EC 132/2023): competência compartilhada, Comitê Gestor, princípio do destino e alíquotas",
            "source_type": "combo",
            "slice": (869, 947),
            "tags": ["Reforma Tributária", "IBS", "EC 132/2023", "Comitê Gestor", "Destino"],
        },
        {
            "num": 18,
            "title": "Aula 18 - Contribuição sobre Bens e Serviços (CBS)",
            "subtitle": "Reforma Tributária: competência da União, base de cálculo ampla, créditos financeiros e Imposto Seletivo (IS)",
            "source_type": "combo",
            "slice": (947, 1045),
            "tags": ["Reforma Tributária", "CBS", "Imposto Seletivo", "EC 132/2023"],
        },
        {
            "num": 19,
            "title": "Aula 19 - Repartição das Receitas Tributárias",
            "subtitle": "Repartição direta e indireta, Fundo de Participação dos Estados (FPE), Municípios (FPM) e Fundos Regionais",
            "source_type": "combo",
            "slice": (1045, 1141),
            "tags": ["Repartição de Receitas", "FPE", "FPM", "CF art. 157 a 162"],
        },
        {
            "num": 20,
            "title": "Aula 20 - Simples Nacional (LC 123/2006) – Parte I",
            "subtitle": "Regime favorecido constitucional, conceito e limites de ME e EPP, tributos abrangidos, opção e vedações",
            "source_type": "combo",
            "slice": (1141, 1274),
            "tags": ["Simples Nacional", "LC 123/2006", "ME e EPP", "Vedações"],
        },
        {
            "num": 21,
            "title": "Aula 21 - Simples Nacional (LC 123/2006) – Parte II",
            "subtitle": "Base de cálculo, segregação de receitas, determinação de alíquotas efetivas, anexos e fiscalização",
            "source_type": "combo",
            "slice": (1274, len(combo_elems)),
            "tags": ["Simples Nacional", "Alíquotas Efetivas", "Anexos", "Fiscalização"],
        },
    ]

    resumos = []
    total_words = 0
    total_tables = 0

    for meta in items_meta:
        if meta["source_type"] == "file":
            elems = parse_docx_elements(resumo_dir / meta["file"])
        else:
            s, e = meta["slice"]
            elems = combo_elems[s:e]

        # Clean top headings if they repeat course / aula titles
        while elems and elems[0][0] == 'p':
            p_text = re.sub(r"[*_`#]", "", elems[0][1]).strip()
            if re.match(r"(?i)^(?:resumo|aula\s*\d+|direito tribut[aá]rio)", p_text) and len(p_text) < 150:
                elems = elems[1:]
            elif re.search(r"(?i)\b(?:Prof\.?\s+[A-Z]|SEFAZ-SP|curso:)", p_text):
                elems = elems[1:]
            else:
                break

        markdown = elements_to_markdown(elems)
        read_time = estimate_read_time(markdown)
        word_count = len(re.findall(r"\w+", markdown))
        tbl_count = sum(1 for k, d, s in elems if k == 'tbl')

        total_words += word_count
        total_tables += tbl_count

        resumo_id = f"resumo-dt-{meta['num']:02d}"
        resumo = {
            "id": resumo_id,
            "order": meta["num"],
            "subject": "Direito Tributário",
            "subjectId": stable_id("Direito Tributário"),
            "title": meta["title"],
            "subtitle": meta["subtitle"],
            "readTimeMinutes": read_time,
            "wordCount": word_count,
            "tableCount": tbl_count,
            "tags": meta["tags"],
            "content": markdown,
        }
        resumos.append(resumo)
        print(f"[{meta['num']:02d}] {meta['title']} -> {word_count} words, {tbl_count} tables, ~{read_time} min")

    result = {
        "generatedAt": __import__("datetime").datetime.now().astimezone().isoformat(timespec="seconds"),
        "discipline": "Direito Tributário",
        "total": len(resumos),
        "totalWords": total_words,
        "totalTables": total_tables,
        "resumos": resumos,
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nSuccessfully generated {len(resumos)} summaries ({total_words} words, {total_tables} tables) in {output_path}")
    return result

if __name__ == "__main__":
    resumo_dir = Path(r"C:\Users\Magno Santos\OneDrive\Desktop\ESTUDO\_Estrategia_SEFAZ-SP_2025\zip\Resumo_tributario")
    output_path = Path(r"C:\Users\Magno Santos\OneDrive\Desktop\ESTUDO\_Estrategia_SEFAZ-SP_2025\zip\extraidos\data\resumos.json")
    build_all_resumos(resumo_dir, output_path)
