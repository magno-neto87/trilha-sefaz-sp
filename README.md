# Trilha — estudos para concursos

Aplicação de estudos para materiais Markdown organizados por disciplina. Usa Python (biblioteca padrão) para importar os arquivos e HTML/CSS/JavaScript nativos no site. O acesso aos materiais exige uma conta Supabase; o conteúdo é carregado de um bucket privado depois da autenticação.

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
- **Conteúdos:** seleção de disciplina dentro da aba, busca e navegação por material, marcação persistente de conteúdos estudados, leitura em coluna central com tipografia responsiva, títulos hierárquicos, sumários com números, títulos e páginas alinhados, tabelas responsivas e quebra segura de texto longo, além de controles para reduzir ou ocultar a lista de materiais.
- **Questões:** treino por disciplina, embaralhamento aleatório das questões com gabarito e alternativas, eliminação de alternativas com tachado e simulados aleatórios configuráveis por disciplina ou pelo banco completo. No modo aleatório, cada resposta é registrada como nova tentativa; os simulados mostram gabarito e solução apenas depois da entrega.
- **Mapas mentais:** mapa de tópicos construído a partir dos títulos Markdown e uma área para guardar links ou imagens.
- **Flashcards:** cartões gerados a partir de títulos e trechos de seus materiais; navegação por botões ou teclado.
- **Organização dos estudos:** rotina semanal, plano automático para o concurso com pesos editáveis por disciplina, calendário de metas/revisões/simulados, metas diárias, Pomodoro, lembretes de revisão espaçada de questões e conteúdos e diário de estudos. Sem login, as configurações ficam no armazenamento local do navegador; lembretes aparecem ao abrir a plataforma.
- **Conta e histórico:** tela de entrada obrigatória e exclusiva para o e-mail autorizado, redefinição de senha e sincronização do progresso entre dispositivos usando Supabase.

## Extração e formato

O extrator separa blocos de questões identificados por marcadores numerados (por exemplo, `**Questão** 4001081845` ou `Questão 12`), identifica alternativas A–E em linhas separadas ou na mesma linha (inclusive com quebras HTML), procura respostas indicadas por “Gabarito” ou “Resposta” e conserva o texto de solução/comentário. Também remove cabeçalhos repetidos e contadores de página comuns em PDFs, marcadores de conversão de imagem e tags de apresentação residuais, e mantém apenas a ocorrência mais completa de questões repetidas com o mesmo identificador externo em cada disciplina. A parte teórica mantém o Markdown fora desses blocos.

A identificação depende do formato dos arquivos de origem. Questões sem um marcador numérico ou com gabarito apresentado em formato incomum podem permanecer no texto teórico ou aparecer sem resposta identificada; confira o material original antes de usar um gabarito. Os flashcards são sugestões automáticas baseadas nos títulos e primeiros parágrafos, e devem ser revisados como ferramenta de estudo.

## Configurar login e materiais privados

O site é estático e não guarda senhas por conta própria. Para habilitar contas, configure um projeto Supabase:

1. No **SQL Editor** do projeto Supabase, execute `supabase-schema.sql`. Além da tabela de progresso e das políticas por usuário, o script cria o bucket privado `study-materials` e restringe leitura dos materiais e acesso ao progresso ao ID da conta autorizada.
2. Em **Storage > study-materials**, carregue o conteúdo da pasta `data` gerada por `python extractor.py`: envie `manifest.json`, `question-index.json` e todos os JSONs da subpasta `subjects`, mantendo os caminhos indicados no `manifest.json`. O bucket precisa continuar **privado**. Os JSONs em `subjects` têm até cerca de 8 MB; o limite do bucket configurado pelo script é 10 MB por arquivo. Sempre que atualizar os materiais, gere `data` novamente e substitua os JSONs no bucket privado; não os publique no repositório.
3. Configure em **Authentication > URL Configuration** a URL do site `https://magno-neto87.github.io/trilha-sefaz-sp/` e os redirecionamentos `https://magno-neto87.github.io/trilha-sefaz-sp/**` e `http://localhost:8000/**`.
4. Confira `url` e `publishableKey` em `supabase-config.js`. A chave publishable é destinada ao navegador; **nunca** coloque `sb_secret_`, `service_role`, senha de banco ou outra chave secreta nesse arquivo.
5. Em **Authentication > Settings**, desative novos cadastros públicos. A conta autorizada já deve existir em **Authentication > Users**; se não existir, crie-a pelo painel e atualize o ID autorizado no `app.js` e no `supabase-schema.sql`. Não cadastre nem compartilhe a senha em código ou no repositório.
6. Publique a aplicação. A tela de entrada bloqueia o site até que a autenticação e o carregamento dos materiais privados terminem. Outras contas são rejeitadas na aplicação e não conseguem ler os materiais nem o progresso pelas políticas do Supabase.

As senhas são gerenciadas pelo Supabase e não são gravadas no histórico da aplicação. O botão **Esqueci minha senha** envia um link de redefinição. Tentativas, simulados e dados de organização continuam sincronizados por conta. Se houver progresso local neste navegador, ele fica preservado e pode ser mesclado pela opção **Importar histórico deste dispositivo** depois da entrada.

### Atenção: repositório público e cópias antigas

Os materiais foram removidos dos arquivos publicados e o histórico público do GitHub foi reescrito para remover esses arquivos dos commits anteriores. Isso alterou os identificadores dos commits e da tag `v1.0`. Cópias já baixadas por terceiros ou mantidas em forks e clones não podem ser recolhidas. Os arquivos originais e o histórico anterior foram preservados localmente; não publique a branch local `local-backup/material-history-before-rewrite`, pois ela contém as versões antigas dos materiais.

## Testes

```powershell
python -m unittest discover -s tests
```

O progresso, os materiais marcados como estudados, as alternativas riscadas, os resultados de simulados e as referências de mapas ficam no `localStorage` e são sincronizados com a conta Supabase após a entrada. Os materiais didáticos são lidos do bucket privado e não devem ser incluídos na publicação estática. As respostas registradas após esta atualização incluem o tempo gasto; respostas antigas não têm duração retroativa. Assuntos e bancas dependem do formato da fonte e podem não ser identificados em todos os itens. Para apagar dados apenas locais, limpe os dados do site nas configurações do navegador.
