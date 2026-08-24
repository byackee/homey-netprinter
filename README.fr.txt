Network Printer fait remonter les niveaux d'encre et de toner de votre
imprimante dans Homey : une cartouche presque vide devient quelque chose sur
quoi un Flow peut agir, au lieu d'une découverte au milieu d'une impression.
L'état, le message affiché sur le panneau de l'imprimante, les bacs à papier et
le compteur de pages suivent.

Une seule app couvre toutes les marques, parce que tout ce qu'elle lit vient du
Printer-MIB standard que les imprimantes réseau implémentent. Rien n'est codé en
dur par modèle : le nombre de cartouches, leurs noms et leurs couleurs sont
découverts auprès de l'imprimante elle-même, si bien qu'un laser de bureau à
quatre cartouches et une photo à neuf cartouches fonctionnent sans rien changer.
L'ajout d'une imprimante cherche sur votre réseau, il n'y a en général rien à
saisir.
