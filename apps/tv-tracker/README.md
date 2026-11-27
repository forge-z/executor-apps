# TV Tracker

Template de app Executor para acompanhar séries, temporadas e episódios.

## O que faz

- Organiza séries em quatro grupos: assistindo, pendentes, em dia e terminadas.
- Guarda onde você parou e até qual temporada já foi lançada.
- Registra gênero, plataforma e notas livres.
- Marca cada episódio como assistido individualmente.
- Mantém recomendações com motivo, plataforma e fonte.
- Persiste séries, episódios e recomendações no banco do próprio app.

## Instalação

Crie um app novo no Executor usando os arquivos desta pasta. Não sobrescreva outro app. O `package.json` fixa a versão do framework usada no desenvolvimento; se o Executor exigir outra, atualize `apps` para a versão informada pelo servidor antes de criar o app.

O template não contém séries, episódios ou recomendações preenchidos. As migrações criam apenas as tabelas vazias.

## Verificação

Depois do deploy, confira `listShows`, `listSuggestions` e `listEpisodes`: todos devem retornar arrays vazios. Para testar o checkbox, adicione uma série pela interface, abra `Episódios`, adicione um episódio e marque-o como assistido.
