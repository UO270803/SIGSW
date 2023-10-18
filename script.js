var map;
var markersArray = [];

var TileWMS = function (coord, zoom) {
    var WMS_URL = 'https://servicios.idee.es/wms-inspire/transportes?';
    var WMS_Layers = 'TN.RoadTransportNetwork.RoadLink,TN.RoadTransportNetwork.RoadServiceArea';
    var proj = map.getProjection();
    var zfactor = Math.pow(2, zoom);
    var top = proj.fromPointToLatLng(new google.maps.Point(coord.x * 256 / zfactor, coord.y * 256 / zfactor));
    var bot = proj.fromPointToLatLng(new google.maps.Point((coord.x + 1) * 256 / zfactor, (coord.y + 1) * 256 / zfactor));
    var bbox = top.lng() + "," + bot.lat() + "," + bot.lng() + "," + top.lat();

    var myURL = WMS_URL + "SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&SRS=EPSG%3A4326&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE";
    myURL += "&LAYERS=" + WMS_Layers;
    myURL += "&BBOX=" + bbox;
    return myURL;
}

var directionsDisplay;
var directionsService;
let myPosition;

function initMap() {
    let defaultCenter = new google.maps.LatLng(43.360664, -5.850464);
    initialize(defaultCenter);
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition((position => {
            const center = new google.maps.LatLng(position.coords.latitude, position.coords.longitude);
            map.setCenter(center);
            myPosition.setPosition(center);
        }));
    }
}

function getPrice(price) {
    if (price === "free") return "0,00";
    else if (price.includes("€")) {
        let pos = price.indexOf("€");
        return price.substring(pos - 4, pos);
    }
    else return price.trim().substring(0, 4);
}

function loadGoogleAutocomplete(center) {
    const inputOrigen = document.getElementById("inputOrigen");
    const inputDestino = document.getElementById("inputDestino");

    const spainBounds = new google.maps.LatLngBounds(
        new google.maps.LatLng(36.000, -10.000),
        new google.maps.LatLng(43.740, 4.330)
    );

    const options = {
        bounds: spainBounds,
        componentRestrictions: {country: "es"},
        fields: ["name"],
        strictBounds: false,
        types: ["address"]
    }

    new google.maps.places.Autocomplete(inputOrigen, options);
    new google.maps.places.Autocomplete(inputDestino, options);

    const geocoder = new google.maps.Geocoder();
    geocoder.geocode({location: center}, (results, status) => {
        if(status === google.maps.GeocoderStatus.OK && results[0])
            inputOrigen.value = results[0].formatted_address;
    });
}

function initialize(center) {
    loadGoogleAutocomplete(center);

    directionsDisplay = new google.maps.DirectionsRenderer({
        polylineOptions: {
            strokeColor: '#3282ea', // Color de la línea de la ruta
            strokeOpacity: 1.0,
            strokeWeight: 7 // Grosor de la línea de la ruta (ajústalo según tus necesidades)
        }
    });
    directionsService = new google.maps.DirectionsService();

    var misOpciones = {
        zoom: 9,
        center: center,
        mapTypeId: google.maps.MapTypeId.ROADMAP,
        styles: estiloMapa
    };
    map = new google.maps.Map(document.getElementById("map_canvas"), misOpciones);
    myPosition = new google.maps.Marker({
        position: center,
        map: map,
        icon: "media/miPosicion.png",
    });
    myPosition.setZIndex(1000);

    var overlayOptions =
    {
        getTileUrl: TileWMS,
        tileSize: new google.maps.Size(256, 256)
    };
    var overlayWMS = new google.maps.ImageMapType(overlayOptions);
    map.overlayMapTypes.push(overlayWMS);
    directionsDisplay.setMap(map);
    getCargadores();
}

function calcularRuta(e) {
    e.preventDefault();
    const start = e.target["inputOrigen"].value;
    const end = e.target["inputDestino"].value;
    const autonomia = parseInt(e.target["inputAutonomia"].value);
    const cargaBateria = parseFloat(e.target["inputBateria"].value) / 100;
    const peticion = {
        origin: start,
        destination: end,
        travelMode: google.maps.DirectionsTravelMode.DRIVING
    };

    directionsService.route(peticion, async function (response, status) {
        if (status !== google.maps.DirectionsStatus.OK) return;
        limpiarRuta();

        let rutaRestante = response.routes[0].overview_path;
        let cargaRestante = cargaBateria;
        const cargadores = [];

        while (rutaRestante.length > 0) {
            const datosMejorCargador = await getMejorCargador(rutaRestante, autonomia, cargaRestante);
            if (datosMejorCargador === null) {
                alert("No se ha encontrado una ruta");
                return;
            }

            rutaRestante = datosMejorCargador.rutaRestante;
            cargaRestante = datosMejorCargador.cargaRestante;
            if (datosMejorCargador.cargador !== null) {
                cargadores.push(datosMejorCargador.cargador);
            }
        }

        const peticionConCargadores = {
            origin: start,
            destination: end,
            waypoints: cargadores.map(({lat, lng}) => ({ location: new google.maps.LatLng(lat, lng) })),
            travelMode: google.maps.DirectionsTravelMode.DRIVING
        };

        directionsService.route(peticionConCargadores, async function (response, status) {
            if (status !== google.maps.DirectionsStatus.OK) return;
            directionsDisplay.setDirections(response);
        });
    });
    return false;
}

async function getMejorCargador(ruta, autonomia, cargaBateria) {
    const autonomiaRestante =  autonomia * cargaBateria;
    let dist = 0;
    let puntoParaBuscar = null;

    for (let i = 0; i < ruta.length - 1; i++) {
        dist += google.maps.geometry.spherical.computeDistanceBetween(ruta[i], ruta[i + 1]) / 1000;
        if (dist + 50 > autonomiaRestante) {
            puntoParaBuscar = i + 1;
            break;
        }
    }

    if (puntoParaBuscar === null) {
        return {
            rutaRestante: [],
            cargaRestante: autonomiaRestante - dist / autonomia,
            cargador: null
        };
    }

    let cargadores = [];
    for (; puntoParaBuscar >= 0; puntoParaBuscar--) {
        cargadores = await getCargadores({
            distancia: 25, 
            lat: ruta[puntoParaBuscar].lat(),
            lng: ruta[puntoParaBuscar].lng()
        });
        if (cargadores.length !== 0) break;
    }

    if (cargadores.length === 0) return null;

    const mejorCargador = cargadores.sort((a, b) => {
        if (a.PrecioCalculado !== b.PrecioCalculado) {
            return a.PrecioCalculado - b.PrecioCalculado;
        }
        return a.AddressInfo.Distance - b.AddressInfo.Distance;
    })[0];

    const marcador = markers.get(mejorCargador.ID);
    marcador.setIcon("media/electricidad_seleccionada.png");

    return {
        rutaRestante: ruta.slice(puntoParaBuscar + 1),
        cargaRestante: 1 - (2 * mejorCargador.AddressInfo.Distance) / autonomia,
        cargador: {
            lat: mejorCargador.AddressInfo.Latitude, 
            lng: mejorCargador.AddressInfo.Longitude
        }
    };
}

const markers = new Map();

async function getCargadores(coordenadas = null) {
    const url = "https://api.openchargemap.io/v3/poi";
    let query = "statustypeid=50&usagetypeid=1,4,5,7&maxresults=1000&countrycode=ES&camelcase=false&key=ee289fb2-57ea-453d-84ce-70d9906b84d9";
    if (coordenadas) {
        const {distancia, lat, lng} = coordenadas;
        query += `&latitude=${lat}&longitude=${lng}&distance=${distancia}&distanceunit=2`;
    }

    const res = await fetch(`${url}?${query}`);
    if (!res.ok) return;

    let data = await res.json();
    data = data.filter(element => element.UsageCost != "" && element.UsageCost != null)
    data.forEach(element => {
        const price = getPrice(element.UsageCost);
        element.PrecioCalculado = parseFloat(price.replace(',', '.'));

        if (!markers.has(element.ID)) {
            const marker = new google.maps.Marker({
                position: { lat: element.AddressInfo.Latitude, lng: element.AddressInfo.Longitude },
                map: map,
                icon: "media/electricidad.png",
            });

            ((marker, element) => {
                marker.addListener('click', () => {

                    new google.maps.InfoWindow({
                        content: '<h3>' + element.AddressInfo.Title + '</h3>' +
                            '<p>Dirección: ' + element.AddressInfo.AddressLine1 + '</p>' +
                            '<p>Precio: ' + price + ' €/kWh</p>' +
                            '<p>Conexiones: <ul>' + element.Connections.map(conn => {
                                return '<li>' + conn.CurrentType?.Title + ' - ' + conn.PowerKW + 'kW</li>'
                            }) + '</ul></p>'
                    }).open(map, marker);
                });
            })(marker, element);

            markers.set(element.ID, marker);
        }
    });

    return data;
}

function limpiarRuta() {
    for (const marker of markers.values()) {
        if (marker.getIcon() !== "media/electricidad.png") {
            marker.setIcon("media/electricidad.png");
        }
    }
}