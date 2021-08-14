/*
   Copyright 2016 kanreisa

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/
import { getProgramItemId } from "./Program";
import * as db from "./db";
import _ from "./_";
import * as aribts from "aribts";
const TsChar = aribts.TsChar;
const TsDate = aribts.TsDate;

const STREAM_CONTENT = {
    1: "mpeg2",
    5: "h.264",
    9: "h.265"
};

const COMPONENT_TYPE = {
    0x01: "480i",
    0x02: "480i",
    0x03: "480i",
    0x04: "480i",
    0x83: "4320p",
    0x91: "2160p",
    0x92: "2160p",
    0x93: "2160p",
    0x94: "2160p",
    0xA1: "480p",
    0xA2: "480p",
    0xA3: "480p",
    0xA4: "480p",
    0xB1: "1080i",
    0xB2: "1080i",
    0xB3: "1080i",
    0xB4: "1080i",
    0xC1: "720p",
    0xC2: "720p",
    0xC3: "720p",
    0xC4: "720p",
    0xD1: "240p",
    0xD2: "240p",
    0xD3: "240p",
    0xD4: "240p",
    0xE1: "1080p",
    0xE2: "1080p",
    0xE3: "1080p",
    0xE4: "1080p",
    0xF1: "180p",
    0xF2: "180p",
    0xF3: "180p",
    0xF4: "180p"
};

const SAMPLING_RATE = {
    0: -1,
    1: 16000,
    2: 22050,
    3: 24000,
    4: -1,
    5: 32000,
    6: 44100,
    7: 48000
};

const UNKNOWN_START_TIME = Buffer.from([0xFF, 0xFF, 0xFF]);
const UNKNOWN_DURATION = Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0xFF]);

interface EventState {
    version: { [tableId: number]: number };
    program: db.Program;

    short: {
        version: number; // basic
        event_name_char: Buffer;
        text_char: Buffer;
    };
    extended: {
        version: number; // extended
        _descs: {
            item_description_length: number;
            item_description_char: Buffer;
            item_length: number;
            item_char: Buffer;
        }[][];
        _done: boolean;
    };
    component: {
        version: number; // basic
        stream_content: number;
        component_type: number;
    };
    content: {
        version: number; // basic
        _raw: Buffer;
    };
    audio: {
        version: number; // basic
        _raw: Buffer;
    };
    series: {
        version: number; // basic
        _raw: Buffer;
    };
    group: {
        versions: number[]; // basic
        _raws: Buffer[];
        _groups: db.ProgramRelatedItem[][];
    };
}

// forked from rndomhack/node-aribts/blob/1e7ef94bba3d6ac26aec764bf24dde2c2852bfcb/lib/epg.js
export default class EPG {

    private _epg: { [networkId: number]: { [serviceId: number]: { [eventId: number]: EventState } } } = {};

    write(eit: any) {

        const networkId = eit.original_network_id;

        if (!this._epg[networkId]) {
            this._epg[networkId] = {};
        }

        if (!this._epg[networkId][eit.service_id]) {
            this._epg[networkId][eit.service_id] = {};
        }

        const service = this._epg[networkId][eit.service_id];

        for (const e of eit.events) {
            let state: EventState;

            if (!service[e.event_id]) {
                const id = getProgramItemId(networkId, eit.service_id, e.event_id);
                let programItem = _.program.get(id);
                if (!programItem) {
                    if (UNKNOWN_START_TIME.compare(e.start_time) === 0) {
                        continue;
                    }
                    programItem = {
                        id,
                        eventId: e.event_id,
                        serviceId: eit.service_id,
                        networkId: networkId,
                        startAt: getTime(e.start_time),
                        duration: UNKNOWN_DURATION.compare(e.duration) === 0 ? 1 : getTimeFromBCD24(e.duration),
                        isFree: e.free_CA_mode === 0
                    };
                    _.program.add(programItem);
                }

                state = {
                    version: {
                        [eit.table_id]: eit.version_number
                    },
                    program: programItem,

                    short: {
                        version: -1,
                        event_name_char: null,
                        text_char: null
                    },
                    extended: {
                        version: -1,
                        _descs: null,
                        _done: true
                    },
                    component: {
                        version: -1,
                        stream_content: -1,
                        component_type: -1
                    },
                    content: {
                        version: -1,
                        _raw: null
                    },
                    audio: {
                        version: -1,
                        _raw: null
                    },
                    series: {
                        version: -1,
                        _raw: null
                    },
                    group: {
                        versions: [-1, -1, -1, -1, -1],
                        _raws: [null, null, null, null, null],
                        _groups: [[], [], [], [], []]
                    }
                };

                service[e.event_id] = state;
            } else {
                state = service[e.event_id];

                if (isOutOfDate(state, eit)) {
                    state.version[eit.table_id] = eit.version_number;

                    if (UNKNOWN_START_TIME.compare(e.start_time) !== 0) {
                        _.program.set(state.program.id, {
                            startAt: getTime(e.start_time),
                            duration: UNKNOWN_DURATION.compare(e.duration) === 0 ? 1 : getTimeFromBCD24(e.duration),
                            isFree: e.free_CA_mode === 0
                        });
                    }
                }
            }

            const m = e.descriptors.length;
            for (let j = 0; j < m; j++) {
                const d = e.descriptors[j];

                switch (d.descriptor_tag) {
                    // short_event
                    case 0x4D:
                        if (state.short.version === eit.version_number) {
                            break;
                        }
                        state.short.version = eit.version_number;

                        if (
                            state.short.event_name_char !== null &&
                            state.short.text_char !== null &&
                            state.short.event_name_char.compare(d.event_name_char) === 0 &&
                            state.short.text_char.compare(d.text_char) === 0
                        ) {
                            break;
                        }

                        state.short.event_name_char = d.event_name_char;
                        state.short.text_char = d.text_char;

                        _.program.set(state.program.id, {
                            name: new TsChar(d.event_name_char).decode(),
                            description: new TsChar(d.text_char).decode()
                        });

                        break;

                    // extended_event
                    case 0x4E:
                        if (state.extended.version !== eit.version_number) {
                            state.extended.version = eit.version_number;
                            state.extended._descs = new Array(d.last_descriptor_number + 1);
                            state.extended._done = false;
                        } else if (state.extended._done) {
                            break;
                        }

                        if (!state.extended._descs[d.descriptor_number]) {
                            state.extended._descs[d.descriptor_number] = d.items;

                            let comp = true;
                            for (const descs of state.extended._descs) {
                                if (typeof descs === "undefined") {
                                    comp = false;
                                    break;
                                }
                            }
                            if (comp === false) {
                                break;
                            }

                            const extended: any = {};

                            let current = "";
                            for (const descs of state.extended._descs) {
                                for (const desc of descs) {
                                    const key = desc.item_description_length === 0
                                                ? current
                                                : new TsChar(desc.item_description_char).decode();
                                    current = key;
                                    extended[key] = extended[key] ?
                                        Buffer.concat([extended[key], desc.item_char]) :
                                        Buffer.from(desc.item_char);
                                }
                            }
                            for (const key of Object.keys(extended)) {
                                extended[key] = new TsChar(extended[key]).decode();
                            }

                            _.program.set(state.program.id, {
                                extended: extended
                            });

                            state.extended._done = true; // done
                        }

                        break;

                    // component
                    case 0x50:
                        if (state.component.version === eit.version_number) {
                            break;
                        }
                        state.component.version = eit.version_number;

                        if (
                            state.component.stream_content === d.stream_content &&
                            state.component.component_type === d.component_type
                        ) {
                            break;
                        }

                        state.component.stream_content = d.stream_content;
                        state.component.component_type = d.component_type;

                        _.program.set(state.program.id, {
                            video: {
                                type: <db.ProgramVideoType> STREAM_CONTENT[d.stream_content] || null,
                                resolution: <db.ProgramVideoResolution> COMPONENT_TYPE[d.component_type] || null,

                                streamContent: d.stream_content,
                                componentType: d.component_type
                            }
                        });

                        break;

                    // content
                    case 0x54:
                        if (state.content.version === eit.version_number) {
                            break;
                        }
                        state.content.version = eit.version_number;

                        if (
                            state.content._raw !== null &&
                            state.content._raw.compare(d._raw) === 0
                        ) {
                            break;
                        }

                        state.content._raw = d._raw;

                        _.program.set(state.program.id, {
                            genres: d.contents.map(getGenre)
                        });

                        break;

                    // audio component
                    case 0xC4:
                        if (state.audio.version === eit.version_number) {
                            break;
                        }
                        state.audio.version = eit.version_number;

                        if (
                            state.audio._raw !== null &&
                            state.audio._raw.compare(d._raw) === 0
                        ) {
                            break;
                        }

                        state.audio._raw = d._raw;

                        _.program.set(state.program.id, {
                            audio: {
                                samplingRate: SAMPLING_RATE[d.sampling_rate],
                                componentType: d.component_type
                            }
                        });

                        break;

                    // series
                    case 0xD5:
                        if (state.series.version === eit.version_number) {
                            break;
                        }
                        state.series.version = eit.version_number;

                        if (
                            state.series._raw !== null &&
                            state.series._raw.compare(d._raw) === 0
                        ) {
                            break;
                        }

                        state.series._raw = d._raw;

                        _.program.set(state.program.id, {
                            series: {
                                id: d.series_id,
                                repeat: d.repeat_label,
                                pattern: d.program_pattern,
                                expiresAt: d.expire_date_valid_flag === 1 ?
                                    getTime(Buffer.from(d.expire_date.toString(16), "hex")) :
                                    -1,
                                episode: d.episode_number,
                                lastEpisode: d.last_episode_number,
                                name: new TsChar(d.series_name_char).decode()
                            }
                        });

                        break;

                    // event_group
                    case 0xD6:
                        if (state.group.versions[d.group_type] === eit.version_number) {
                            break;
                        }
                        state.group.versions[d.group_type] = eit.version_number;

                        if (
                            state.group._raws[d.group_type] !== null &&
                            state.group._raws[d.group_type].compare(d._raw) === 0
                        ) {
                            break;
                        }

                        state.group._raws[d.group_type] = d._raw;

                        state.group._groups[d.group_type] = d.group_type < 4 ?
                            d.events.map(getRelatedProgramItem.bind(d)) :
                            d.other_network_events.map(getRelatedProgramItem.bind(d));

                        _.program.set(state.program.id, {
                            relatedItems: state.group._groups.flat()
                        });

                        break;
                }// <- switch
            }// <- for
        }// <- for
    }

    end() {
        this._epg = null;
    }
}

function isOutOfDate(state: EventState, eit: any): boolean {

    if (state.version[eit.table_id] === eit.version_number) {
        return false;
    }

    return true;
}

function getTime(buffer: Buffer): number {

    const mjd = (buffer[0] << 8) | buffer[1];
    const h = (buffer[2] >> 4) * 10 + (buffer[2] & 0x0F);
    const i = (buffer[3] >> 4) * 10 + (buffer[3] & 0x0F);
    const s = (buffer[4] >> 4) * 10 + (buffer[4] & 0x0F);

    return ((mjd - 40587) * 86400 + ((h - 9) * 60 * 60) + (i * 60) + s) * 1000;
}

function getTimeFromBCD24(buffer: Buffer): number {

    let time = ((buffer[0] >> 4) * 10 + (buffer[0] & 0x0F)) * 3600;
    time += ((buffer[1] >> 4) * 10 + (buffer[1] & 0x0F)) * 60;
    time += (buffer[2] >> 4) * 10 + (buffer[2] & 0x0F);

    return time * 1000;
}

function getGenre(content: any): db.ProgramGenre {
    return {
        lv1: content.content_nibble_level_1,
        lv2: content.content_nibble_level_2,
        un1: content.user_nibble_1,
        un2: content.user_nibble_2
    };
}

function getRelatedProgramItem(event: any): db.ProgramRelatedItem {
    return {
        type: (
            this.group_type === 1 ? "shared" :
                (this.group_type === 2 || this.group_type === 4) ? "relay" : "movement"
        ),
        networkId: event.original_network_id,
        serviceId: event.service_id,
        eventId: event.event_id
    };
}