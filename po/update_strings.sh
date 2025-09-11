#!/bin/sh
SCRIPTDIR=`dirname $0`
xgettext  --from-code=UTF-8 -k_ -kN_  -o gnome-extensions-hotspot-toggle.pot "$SCRIPTDIR"/../*.ts "$SCRIPTDIR"/../schemas/*.xml

for fn in *.po; do
	msgmerge -U "$fn" gnome-extensions-hotspot-toggle.pot
done
