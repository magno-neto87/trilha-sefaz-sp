# Trilha — estudos para concursos

Aplicação de estudos para materiais Markdown organizados por disciplina. Usa Python (biblioteca padrão) para importar os arquivos e HTML/CSS/JavaScript nativos no site; sem login, não precisa instalar pacotes nem enviar seu progresso para um serviço externo. A sincronização opcional entre dispositivos usa Supabase após configuração.

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
- **Organização dos estudos:** rotina semanal, plano automático para o concurso com pesos editáveis por disciplina, calendário de metas/revisões/simulados, metas diárias, Pomodoro, lembretes de revisão espaçada de questões e conteúdos e diário de estudos. Sem login, as configurações ficam no armazenamento local do navegador; lembretes aparecem ao abrir a plataforma.
- **Conta e histórico:** cadastro e entrada por e-mail e senha, redefinição de senha e sincronização do progresso entre dispositivos usando Supabase. O modo sem conta continua disponível e salva apenas neste navegador.

## Extração e formato

O extrator separa blocos de questões identificados por marcadores numerados (por exemplo, `**Questão** 4001081845` ou `Questão 12`), identifica alternativas A–E em linhas separadas ou na mesma linha (inclusive com quebras HTML), procura respostas indicadas por “Gabarito” ou “Resposta” e conserva o texto de solução/comentário. Também remove cabeçalhos e contadores de página comuns em PDFs e mantém apenas a ocorrência mais completa de questões repetidas com o mesmo identificador externo em cada disciplina. A parte teórica mantém o Markdown fora desses blocos.

A identificação depende do formato dos arquivos de origem. Questões sem um marcador numérico ou com gabarito apresentado em formato incomum podem permanecer no texto teórico ou aparecer sem resposta identificada; confira o material original antes de usar um gabarito. Os flashcards são sugestões automáticas baseadas nos títulos e primeiros parágrafos, e devem ser revisados como ferramenta de estudo.

## Ativar login e sincronização

O site é estático e não guarda senhas por conta própria. Para habilitar contas, configure um projeto Supabase:

1. Crie um projeto no Supabase e copie a **Project URL** e a chave **publishable** (começa com `sb_publishable_`).
2. No **SQL Editor** do painel Supabase, execute uma vez o conteúdo de `supabase-schema.sql`. A tabela usa Row Level Security (RLS) para permitir que cada conta leia e altere somente a própria linha.
3. Em **Authentication > URL Configuration**, configure como URL do site `https://magno-neto87.github.io/trilha-sefaz-sp/` e adicione à lista de redirecionamentos permitidos `https://magno-neto87.github.io/trilha-sefaz-sp/**` e `http://localhost:8000/**`.
4. Preencha `url` e `publishableKey` em `supabase-config.js` com a URL do projeto e a chave publishable. Esses valores são usados pelo navegador; **nunca** coloque uma chave `sb_secret_`, `service_role` ou outra chave secreta nesse arquivo.
5. Publique a alteração no GitHub Pages. Abra o site, escolha **Entrar > Criar conta** e use um e-mail seu. Se a confirmação de e-mail estiver habilitada, confirme a mensagem recebida antes de entrar.

As senhas são gerenciadas pelo Supabase e não são gravadas no histórico da aplicação. O botão **Esqueci minha senha** envia um link de redefinição. Tentativas, simulados e dados de organização são sincronizados quando a conta está conectada; o conteúdo didático continua público, como o restante do site. Se o navegador já tiver progresso local ao entrar, esse progresso fica preservado no aparelho e pode ser mesclado pela opção **Importar histórico deste dispositivo** na tela da conta. Sem configuração do Supabase, o login fica desativado e o site continua funcionando localmente.

## Testes

```powershell
python -m unittest discover -s tests
```

Sem login, o progresso, os materiais marcados como estudados, as alternativas riscadas, os resultados de simulados e as referências de mapas ficam no `localStorage` do navegador. Com login, esses dados também são sincronizados com a conta Supabase. As respostas registradas após esta atualização incluem o tempo gasto; respostas antigas não têm duração retroativa. Assuntos e bancas dependem do formato da fonte e podem não ser identificados em todos os itens. Para apagar dados apenas locais, limpe os dados do site nas configurações do navegador.
