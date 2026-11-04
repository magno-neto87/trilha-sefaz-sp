# Trilha — estudos para concursos

Aplicação de estudos local para os materiais Markdown organizados em uma pasta por disciplina. A solução usa Python (biblioteca padrão) para importar os arquivos e HTML/CSS/JavaScript nativos no site; não precisa instalar pacotes ou enviar os dados para um serviço externo.

## Iniciar

Abra o PowerShell nesta pasta e execute:

```powershell
python extractor.py
python -m http.server 8000
```

Visite [http://localhost:8000](http://localhost:8000). O servidor HTTP é necessário porque o navegador bloqueia a leitura dos arquivos JSON quando a página é aberta diretamente com `file://`.

Para processar outra pasta de materiais:

```powershell
python extractor.py "C:\caminho\para\materiais" --output ".\data"
```

O extrator percorre as subpastas imediatas como disciplinas e encontra arquivos `.md` em cada uma, inclusive em subpastas internas. Cada execução atualiza `data\manifest.json`, um arquivo JSON por disciplina em `data\subjects\` e o índice leve `data\question-index.json`, usado para cruzar o histórico com assuntos e bancas. Os arquivos PDF originais não são alterados.

## O que está incluído

- **Visão geral:** taxa geral e desempenho por disciplina, assunto e banca, evolução semanal, comparação entre semanas, tempo médio por questão, mapa de calor e previsão suavizada baseada no histórico. O painel identifica quando ainda não há amostra suficiente; a previsão é uma estimativa, não uma garantia.
- **Conteúdos:** seleção de disciplina dentro da aba, busca e navegação por material, marcação persistente de conteúdos estudados, renderização Markdown e controles para reduzir ou ocultar a lista de materiais. A extração remove mensagens promocionais, links de plataforma, cabeçalhos e créditos de professores e datas de atualização dos documentos.
- **Questões:** treino por disciplina, embaralhamento aleatório das questões com gabarito e alternativas, eliminação de alternativas com tachado e simulados aleatórios configuráveis por disciplina ou pelo banco completo. No modo aleatório, cada resposta é registrada como nova tentativa; os simulados mostram gabarito e solução apenas depois da entrega.
- **Mapas mentais:** mapa de tópicos construído a partir dos títulos Markdown e uma área para guardar links ou imagens.
- **Flashcards:** cartões gerados a partir de títulos e trechos de seus materiais; navegação por botões ou teclado.
- **Organização dos estudos:** rotina semanal, plano automático para o concurso com pesos editáveis por disciplina, calendário de metas/revisões/simulados, metas diárias, Pomodoro, lembretes de revisão espaçada de questões e conteúdos e diário de estudos. As configurações ficam no armazenamento local do navegador; lembretes aparecem ao abrir a plataforma.

## Extração e formato

O extrator separa blocos de questões identificados por marcadores numerados (por exemplo, `**Questão** 4001081845` ou `Questão 12`), identifica alternativas A–E em linhas separadas ou na mesma linha (inclusive com quebras HTML), procura respostas indicadas por “Gabarito” ou “Resposta” e conserva o texto de solução/comentário. Também remove cabeçalhos e contadores de página comuns em PDFs e mantém apenas a ocorrência mais completa de questões repetidas com o mesmo identificador externo em cada disciplina. A parte teórica mantém o Markdown fora desses blocos.

A identificação depende do formato dos arquivos de origem. Questões sem um marcador numérico ou com gabarito apresentado em formato incomum podem permanecer no texto teórico ou aparecer sem resposta identificada; confira o material original antes de usar um gabarito. Os flashcards são sugestões automáticas baseadas nos títulos e primeiros parágrafos, e devem ser revisados como ferramenta de estudo.

## Testes

```powershell
python -m unittest discover -s tests
```

O progresso, os materiais marcados como estudados, as alternativas riscadas, os resultados de simulados e as referências de mapas são guardados no `localStorage` do navegador. As respostas registradas após esta atualização incluem o tempo gasto; respostas antigas não têm duração retroativa. Assuntos e bancas dependem do formato da fonte e podem não ser identificados em todos os itens. Para apagar os dados locais, limpe os dados do site `localhost:8000` nas configurações do navegador.
