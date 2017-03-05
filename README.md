

Wot-Reloaded
------------

Wot Reloaded est un noeud spécialisé de Duniter. 
Cet outil interroge la base de données SQLite et importe les données de la Wot (Web of Trust) dans une base de données graph Neo4j.

Modèle de données
-----------------

Le modèle de données utilisé permet le versionning de la Wot.
C'est à dire qu'il est possible de consulter son historique, son état et sa forme à n'importe quel moment de son passé.

Il a été conçu selon les principes décrit dans cet article.
http://iansrobinson.com/2014/05/13/time-based-versioned-graphs/

Les identités sont représentées sous la forme de nœuds Idty avec les propriétés *uid* (pseudo) et *pubkey* (clé publique). 
On attache à chaque identité un (ou plusieurs) états, représentés sous la forme de noeuds et qui peuvent être :
	- JOINER
	- EXCLUDED
	- SENTRY

L'attachement est réalisé par un lien (relationship) de type STATE qui a les propriétés *from* (timestamp à partir duquel cet état commence) et *to* (timestamp auquel l'identité sort de cet état).
Dans le cas où l'état est encore valide au moment présent la propriété *to* a pour valeur *9223372036854775807* qui correspond à la valeur maximale d'une variable de type *long*.

Par exemple, "inso" a trois liens STATE dans la base neo4j.

	uid     STATE       from        to
    inso	[JOINER]	1485165938	9223372036854776000

Il est *JOINER* depuis le timestamp *1485165938* et l'est toujours puisque le champ *to* est à sa valeur maximale. 

	uid     STATE       from        to
    inso	[SENTRY]	1485165938	1487819583
    inso	[SENTRY]	1488092931	9223372036854776000

Il est devenu *SENTRY* au timestamp *1485165938* et a perdu cet état au timestamp *1487819583*. Il a retrouvé cet état au timestamp *1488092931* et l'est toujours au regard de la valeur du champ *to*.

Les certifications entre les les identités sont représentées par les liens (relationships) de type *CERTIFY* entre les identités. Ces liens possèdent les propriétés *from* (timestamp à partir duquel la certification est valide), *to* (timestamp à partir duquel la certification n'est plus valide) et *written* (timestamp auquel la certification a été écrite dans un bloc).
Contrairement à un état (STATE), le champ to n'est jamais à *9223372036854775807* puisque nous connaissons par avance la durée de validité d'une certification.

Dans l'exemple ci-dessous, inso a émis deux certifications vers cgeek au cours de la vie de la Wot :

    issuer	receiver	date	    expiration
    inso	cgeek	    1485165938	1487757938
    inso	cgeek	    1488004138	1490596138

Voici une représentation graphique du modèle de données.

![enter image description here](https://raw.githubusercontent.com/greyzlii/wot-reloaded/master/doc/Data_Model.jpeg)

Version courante de la Wot
--------------------------

Afin de faciliter les requêtes, **Wot-reloaded** maintient une version courante de la Wot.
A chaque nouveau bloc reçu, l'état courant de la Wot est pré-calculé.

Les identités présentement dans l'état *SENTRY* et/ou *JOINER* reçoivent les propriétés *joiner = true* et/ou *sentry = true*.

Pour chaque certification présentement valide, une copie de cette certification est faîte. Elle est écrite de type *CURRENT_CERTIFY*.


Exemples d'utilisation
----------------------

 - Rechercher les membres présentement exclus

> MATCH (n) -[s:STATE {to:9223372036854775807} ]-> (j:EXCLUDED) RETURN
> n.uid

 - Connaître l'état d'un membre à une date donnée
 
(Note: J'utilise ici le plugin APOC pour convertir les dates en timestamp : https://neo4j-contrib.github.io/neo4j-apoc-procedures/ )

>WITH apoc.date.parse('2017/02/10 00-00-00','s', 'yyyy/MM/dd HH-mm-ss') as date, "inso" as uid
>     MATCH (i:Idty {uid:uid}) -[s:STATE]-> (j)
>     WHERE s.from < date AND s.to > date
>     RETURN i.uid, labels(j)

- Compter le nombres de membres et de sentries à une date donnée.

>WITH apoc.date.parse('2017/02/10 00-00-00','s', 'yyyy/MM/dd HH-mm-ss') as date
>     MATCH () -[s:STATE]-> (:JOINER)
>     WHERE s.from < date AND s.to > date
>     WITH count(s) as joinerCount, date
>     MATCH () -[s:STATE]-> (:SENTRY)
>     WHERE s.from < date AND s.to > date
>     RETURN joinerCount, count(s) as sentryCount
> 
> 
> Written with [StackEdit](https://stackedit.io/).

