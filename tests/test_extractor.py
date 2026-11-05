import json
import tempfile
import unittest
from pathlib import Path

from extractor import (
    deduplicate_subject_questions,
    clean_promotional_content,
    clean_content_artifacts,
    extract,
    extract_questions,
    generate_flashcards,
    normalize_answer,
    parse_options,
)


class ExtractorTests(unittest.TestCase):
    def test_extracts_topic_and_bank_metadata_into_question_index(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory) / "materials"
            subject = root / "Direito Tributário"
            subject.mkdir(parents=True)
            (subject / "aula.md").write_text(
                """## Competência tributária

2021 FCC Questão 123456
Assinale a alternativa correta.
A) Primeira opção
B) Segunda opção
Gabarito: B

## Solução:
Texto explicativo que não deve virar assunto.

2021 FCC Questão 123457
Marque a alternativa correta.
A) Primeira opção
B) Segunda opção
Gabarito: A
""",
                encoding="utf-8",
            )
            output = Path(temporary_directory) / "data"

            manifest = extract(root, output)
            subject_data = json.loads((output / manifest["subjects"][0]["file"]).read_text(encoding="utf-8"))
            questions = subject_data["materials"][0]["questions"]
            index = json.loads((output / manifest["questionIndexFile"]).read_text(encoding="utf-8"))

        self.assertEqual(len(questions), 2)
        self.assertEqual([question["topic"] for question in questions], ["Competência tributária"] * 2)
        self.assertEqual([question["bank"] for question in questions], ["FCC"] * 2)
        self.assertEqual(index["questions"][0]["id"], questions[0]["id"])
        self.assertEqual(index["questions"][0]["topic"], "Competência tributária")
        self.assertEqual(index["questions"][0]["bank"], "FCC")

    def test_extracts_question_options_answer_and_solution(self):
        source = """Teoria antes.
2021 Banca Exemplo **Questão** 123456
Enunciado da questão.
A) Primeira opção
B) Segunda opção
###### **Solução:**
Gabarito: B) correta.
Comentário detalhado da questão.
## Próximo tópico
Teoria depois.
"""
        theory, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertIn("Teoria antes.", theory)
        self.assertNotIn("Enunciado da questão", theory)
        self.assertEqual(len(questions), 1)
        self.assertEqual(questions[0]["answer"], "B")
        self.assertEqual([option["key"] for option in questions[0]["options"]], ["A", "B"])
        self.assertIn("Comentário detalhado", questions[0]["solution"])
        self.assertIn("Teoria depois.", theory)

    def test_parses_multiline_options(self):
        options = parse_options(
            "A) Texto em\ncontinuação\n\nCabeçalho da página\n- B. Outra opção\nC) Terceira opção"
        )
        self.assertEqual(options[0]["text"], "Texto em continuação")
        self.assertEqual(options[1]["key"], "B")
        self.assertEqual(options[2]["key"], "C")

    def test_splits_inline_and_html_break_options(self):
        source = """Banca **Questão** 789123
Escolha a alternativa: A) Primeira resposta. <br>B) Segunda resposta.
Gabarito: B) Segunda resposta.
"""
        _, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertEqual([option["key"] for option in questions[0]["options"]], ["A", "B"])
        self.assertIn("Escolha a alternativa:", questions[0]["statement"])
        self.assertNotIn("Primeira resposta", questions[0]["statement"])

    def test_extracts_options_embedded_in_superscript_markup(self):
        source = """Banca **Questão** 789123
Calcule o resultado: A)<sup>20.000 unidades.</sup> B)<sup>25.000 unidades.</sup>
Gabarito: B) Correta.
"""
        _, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertEqual([option["key"] for option in questions[0]["options"]], ["A", "B"])
        self.assertEqual(questions[0]["options"][0]["text"], "20.000 unidades.")

    def test_extracts_bold_solution_heading_and_keeps_following_theory(self):
        source = """Conteúdo antes.
2021 Banca **Questão** 123456
Enunciado.
A) Incorreta.
B) Correta.
###### **Solução:**
Gabarito: B) Correta.
Explicação da resposta.
**Gabarito: B**
## Continuação da teoria
Texto teórico posterior.
"""
        theory, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertEqual(len(questions), 1)
        self.assertEqual(questions[0]["answer"], "B")
        self.assertEqual([option["key"] for option in questions[0]["options"]], ["A", "B"])
        self.assertNotIn("Solução", questions[0]["options"][-1]["text"])
        self.assertIn("Continuação da teoria", theory)

    def test_removes_pdf_page_headers_and_deduplicates_repeated_question_ids(self):
        source = """Teoria antes.
**Questão** 4000270421
Analista - Planejamento e Execução Financeira (CVM)
O enunciado continua com capacidade ociosa **Contabilidade de Custos para SEFAZ-SP (Auditor Fiscal) - Prof. Júlio Cardozo.**
**17/90**
**2. Conceitos gerais e terminologia aplicável à contabilidade de custos**
de 25% em relação à capacidade instalada?
A) Primeira alternativa
B) Segunda alternativa
###### **Solução:**
Gabarito: B)
Explicação da resposta correta.

**Questão** 4000270421
2003 FCC Comissão de Valores Mobiliários
Analista - Planejamento e Execução Financeira (CVM)
O enunciado continua com capacidade ociosa de 25% em relação à capacidade instalada?
A) Primeira alternativa
B) Segunda alternativa
###### **Solução:**
Gabarito: B)
Explicação da resposta correta.
"""
        theory, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertEqual(len(questions), 1)
        question = questions[0]
        normalized_statement = " ".join(question["statement"].split())
        self.assertIn("capacidade ociosa de 25%", normalized_statement)
        self.assertNotIn("17/90", question["statement"])
        self.assertNotIn("Conceitos gerais e terminologia", question["statement"])
        self.assertNotIn("Contabilidade de Custos para SEFAZ-SP", question["statement"])
        self.assertEqual(question["answer"], "B")
        self.assertEqual([option["key"] for option in question["options"]], ["A", "B"])
        self.assertIn("Teoria antes.", theory)

    def test_removes_standalone_page_counters_from_theory(self):
        source = """## Conteúdo

**1/90**

**1. Conceito inicial**
O conteúdo substantivo permanece.

Documento atualizado em 14/06/2026.
"""
        theory, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertEqual(questions, [])
        self.assertNotIn("1/90", theory)
        self.assertIn("O conteúdo substantivo permanece.", theory)
        self.assertIn("Documento atualizado em 14/06/2026.", theory)

    def test_removes_course_author_and_document_update_metadata(self):
        source = """# Reforma Tributária para SEFAZ-SP (Auditor Fiscal da Receita Estadual - Gestão Tributária) - Prof. Eduardo da Rocha

**Prof. Ana Elizabethe da Silva, Prof. Eduardo da Rocha**

CBS (contribuição sobre bens e serviços).** Documento última vez atualizado em 14/06/2026 às 21:45.

## Conteúdo didático
O conceito foi atualizado pela Lei nº 14.133/2021 e continua válido.
"""
        theory, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertEqual(questions, [])
        self.assertNotIn("Reforma Tributária para SEFAZ-SP", theory)
        self.assertNotIn("Prof. Ana Elizabethe", theory)
        self.assertNotIn("Documento última vez atualizado", theory)
        self.assertIn("## Conteúdo didático", theory)
        self.assertIn("CBS (contribuição sobre bens e serviços).", theory)
        self.assertIn("Lei nº 14.133/2021", theory)

    def test_deduplicates_external_question_ids_across_subject_materials(self):
        materials = [
            {"questions": [
                {"number": "Questão 4000123456", "statement": "Enunciado curto", "options": [], "solution": ""},
                {"number": "Questão 1", "statement": "Questão sem ID externo", "options": [], "solution": ""},
            ]},
            {"questions": [
                {
                    "number": "Questão 4000123456",
                    "statement": "Enunciado completo e revisado",
                    "options": [{"key": "A", "text": "Alternativa"}],
                    "solution": "Resolução completa",
                },
            ]},
        ]
        deduplicate_subject_questions(materials)
        self.assertEqual(len(materials[0]["questions"]), 1)
        self.assertEqual(len(materials[1]["questions"]), 1)
        self.assertEqual(materials[0]["questions"][0]["number"], "Questão 1")
        self.assertEqual(
            materials[1]["questions"][0]["statement"],
            "Enunciado completo e revisado",
        )

    def test_removes_app_qr_and_platform_link_promotions_from_theory(self):
        source = """## Tema da aula
Assista o vídeo pelo APP!

Acesse a plataforma pelo QR code abaixo:

Ou acesse pelo link:

https://concursos.estrategia.com/ldi/curso?topic=2.1
parte-final-do-link

## Conteúdo didático
O conceito contábil deve permanecer no material de estudo.
"""
        cleaned = clean_promotional_content(source)
        self.assertNotIn("Assista o vídeo pelo APP", cleaned)
        self.assertNotIn("QR code", cleaned)
        self.assertNotIn("acesse pelo link", cleaned)
        self.assertNotIn("concursos.estrategia.com", cleaned)
        self.assertNotIn("parte-final-do-link", cleaned)
        self.assertIn("## Tema da aula", cleaned)
        self.assertIn("## Conteúdo didático", cleaned)
        self.assertIn("O conceito contábil deve permanecer", cleaned)

    def test_removes_inline_br_promotion_without_dropping_following_prose(self):
        cleaned = clean_promotional_content(
            "Antes.<br>Assista o vídeo pelo APP! Acesse a plataforma pelo QR code abaixo:"
            "<br>Depois, analise o conceito."
        )
        self.assertIn("Antes.", cleaned)
        self.assertIn("Depois, analise o conceito.", cleaned)
        self.assertNotIn("APP", cleaned)
        self.assertNotIn("QR code", cleaned)

    def test_removes_orphaned_platform_url_without_prompt_text(self):
        cleaned = clean_promotional_content(
            "## Conteúdo\n"
            "https://concursos.estrategia.com/ldi/curso?topic=2.1\n"
            "parte-final-do-link\n\n"
            "O conteúdo teórico continua aqui."
        )
        self.assertNotIn("concursos.estrategia.com/ldi", cleaned)
        self.assertNotIn("parte-final-do-link", cleaned)
        self.assertIn("O conteúdo teórico continua aqui.", cleaned)

    def test_removes_repeated_pdf_headers_but_preserves_unique_headings(self):
        source = """EstratégiaConcursos **1. Título de cabeçalho repetido**
**1. Título de cabeçalho repetido**
**1. Título de cabeçalho repetido**
**1 Capítulo verdadeiro**
**2. Seção legítima**
**Prof. Equipe Direito Tributário**
**2/186**
Texto didático preservado.
"""
        cleaned = clean_content_artifacts(source)
        self.assertNotIn("EstratégiaConcursos", cleaned)
        self.assertNotIn("Título de cabeçalho repetido", cleaned)
        self.assertNotIn("Prof. Equipe", cleaned)
        self.assertNotIn("2/186", cleaned)
        self.assertIn("**1 Capítulo verdadeiro**", cleaned)
        self.assertIn("**2. Seção legítima**", cleaned)
        self.assertIn("Texto didático preservado.", cleaned)

    def test_removes_picture_markers_and_empty_markup_placeholders(self):
        source = """<!-- Start of picture text -->
Instituição de tributos com exceções.
<!-- End of picture text -->
# ~~<u><mark>_</mark></u>~~
Texto com <sup>nota</sup> e quebra<br>mantidos.
"""
        cleaned = clean_content_artifacts(source)
        self.assertNotIn("<!--", cleaned)
        self.assertNotIn("<sup>", cleaned)
        self.assertNotIn("<br>", cleaned)
        self.assertNotIn("<mark>", cleaned)
        self.assertNotIn("~~", cleaned)
        self.assertIn("Instituição de tributos com exceções.", cleaned)
        self.assertIn("Texto com nota e quebra mantidos.", cleaned)
        extracted, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertEqual(questions, [])
        self.assertNotIn("<!--", extracted)
        self.assertNotIn("<sup>", extracted)
        self.assertIn("Instituição de tributos com exceções.", extracted)

    def test_removes_platform_url_split_across_ocr_table_lines(self):
        cleaned = clean_promotional_content(
            "Antes.\n|htti\n"
            "ps://concursos.estrategia.com/ldi/curso?topic=4.5|\n"
            "adual-gestao-tributaria-professor-pos-edital|\n|---|---|\n"
            "## Próximo tópico\nTexto didático."
        )
        self.assertNotIn("htti", cleaned)
        self.assertNotIn("concursos.estrategia.com", cleaned)
        self.assertNotIn("adual-gestao", cleaned)
        self.assertIn("## Próximo tópico", cleaned)
        self.assertIn("Texto didático.", cleaned)

    def test_does_not_invent_missing_answer(self):
        self.assertIsNone(normalize_answer("A questão não apresenta gabarito."))

    def test_skips_pdf_branding_when_generating_flashcards(self):
        markdown = """## <sup>Estratégia</sup> Concursos
Texto de cabeçalho com mais de quarenta caracteres para não ser confundido com vazio.
## 1 Apresentação
Documento última vez atualizado em 30/07/2026 às 20:11.
**Contabilidade Geral para SEFAZ-SP (Auditor Fiscal)**
1. Apresentação ............................................................................... 3
## 1.1 Introdução
Escute o Cast pelo APP. Acesse a plataforma pelo QR code abaixo:
https://example.invalid/curso
## Conteúdo
Quem conhece os cursos do Estratégia sabe que trabalhamos basicamente com a seguinte estrutura didática.
## Conceito fundamental
Este conceito explica como os elementos principais se relacionam e orientam o estudo.
"""
        cards = generate_flashcards(markdown, "Disciplina/aula.md")
        self.assertEqual(len(cards), 1)
        self.assertEqual(cards[0]["front"], "Conceito fundamental")

    def test_skips_question_blocks_without_multiple_choice_options(self):
        source = """## Conteúdo
Questão 987654
Texto longo sem alternativas.
Gabarito: A
## Próximo tópico
Texto final.
"""
        theory, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertEqual(questions, [])
        self.assertIn("Texto final.", theory)

    def test_ignores_question_markers_in_solution_text(self):
        source = """2021 FCC Questão 1001
A) Alternativa correta
B) Alternativa errada
Gabarito: A
#### Solução:
Explicação da primeira questão.
Questão 2002
C) Alternativa incorreta
D) Alternativa correta
Gabarito: D
"""
        theory, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertEqual(len(questions), 1)
        self.assertEqual(questions[0]["number"], "Questão 1001")
        self.assertEqual(questions[0]["answer"], "A")

    def test_extracts_question_with_table_header_and_multiline_options(self):
        source = """Teoria anterior.

||2013|CCV UFC|Universidade Federal do Ceará|
|---|---|---|---|
|**Questão**<br>4001998029||||
||Analista de Tecnologia|da Informação|- Segurança da Informação (UFC)|

Sobre Esteganografia é correto afirmar que:

- A)

É uma categoria de algoritmo criptográfico simétrico.

- B)

É a análise de desempenho dos algoritmos criptográficos.

- C)

É uma técnica para ocultar uma mensagem dentro de outra.

- D)

É um algoritmo matemático.

- E)

- É uma técnica para decifrar o texto cifrado.

###### **Solução:**
Gabarito: C) correta.
Explicação sobre esteganografia.
Gabarito: C

## Próximo tópico
Teoria seguinte.
"""
        theory, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertEqual(len(questions), 1)
        q = questions[0]
        self.assertIn("4001998029", q["number"])
        self.assertEqual(len(q["options"]), 5)
        self.assertEqual(q["answer"], "C")
        self.assertIn("CCV UFC", q["bank"])
        self.assertNotIn("4001998029", theory)
        self.assertNotIn("Sobre Esteganografia", theory)
        self.assertNotIn("CCV UFC", theory)
        self.assertIn("Teoria anterior.", theory)
        self.assertIn("Teoria seguinte.", theory)

    def test_removes_orphan_question_intro_and_preceding_exam_line_from_theory(self):
        source = """Teoria 1.3

Agora, vamos resolver algumas questões:

- 2018 Instituto EXCELÊNCIA Prefeitura Municipal de Barra Velha (SC)

- **Questão** 283800999 Tesoureiro (Pref Barra Velha/SC)

A contabilidade pode ser definida como:
A) Social
B) Exata
###### **Solução:**
Gabarito: A
Explicação.

###### **1.4 Campo de Aplicação da Contabilidade - Teoria**
Conteúdo da seção 1.4
"""
        theory, questions = extract_questions(source, "Disciplina/aula.md")
        self.assertEqual(len(questions), 1)
        self.assertNotIn("Agora, vamos resolver algumas questões:", theory)
        self.assertNotIn("Barra Velha", theory)
        self.assertIn("Teoria 1.3", theory)
        self.assertIn("1.4 Campo de Aplicação da Contabilidade - Teoria", theory)

    def test_removes_running_header_with_truncated_text(self):
        source = """> 0.0 EstratégiaConcursos 1. Contabilidade Geral Contabilidade conceito, objeto, objetivos, campo de atuação e usuári
**Contabilidade Geral para SEFAZ-SP (Auditor Fiscal) - Prof. Júlio Cardozo 10/91**
Texto legítimo preservado.
"""
        cleaned = clean_content_artifacts(source)
        self.assertNotIn("EstratégiaConcursos", cleaned)
        self.assertNotIn("usuári", cleaned)
        self.assertNotIn("10/91", cleaned)
        self.assertIn("Texto legítimo preservado.", cleaned)

    def test_replaces_unicode_replacement_characters(self):
        source = """\ufffd Item de lista com marcador corrompido
Finalidade \ufffd Fornecer informações
Escrituração \ufffd Técnica contábil
"""
        cleaned = clean_content_artifacts(source)
        self.assertNotIn("\ufffd", cleaned)
        self.assertIn("- Item de lista", cleaned)
        self.assertIn("Finalidade → Fornecer informações", cleaned)
        self.assertIn("Escrituração → Técnica contábil", cleaned)


if __name__ == "__main__":
    unittest.main()
