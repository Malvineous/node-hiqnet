/**
 * HiQnet device control library - USB transport layer.
 *
 * Copyright (C) 2020 Adam Nielsen <malvineous@shikadi.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const debug = require('debug')('hiqnet:transport:usb');

const { DeviceBusyError } = require('../error.js');

const HID_REPORT_TX = 1;
const HID_REPORT_RX = 2;
const HID_REPORT_CT = 3;

const HID_REPORT_TX_LEN = 64;
const HID_REPORT_RX_LEN = 64;
const HID_REPORT_CT_LEN = 8;

const HID_CT_INIT_REQ = 1;
const HID_CT_INIT_ACK = 2;
const HID_CT_ALLOC_REQ = 3;
const HID_CT_ALLOC_ACK = 4;
const HID_CT_DEALLOC_REQ = 5;
const HID_CT_DEALLOC_ACK = 6;

class HiQnetTransportUSB
{
	constructor(device)
	{
		this.device = device;

		this.idNext = 0;
		this.pendingMessages = [];
		this.incomingMessages = [];

		this.device.on('data', data => {
			this.handleInterrupt(data);
		});

		this.timerHandle = setInterval(() => {
			this.pollDevice();
		}, 100);
	}

	destructor()
	{
		clearInterval(this.timerHandle);
	}

	async connect()
	{
		const r = await this.sendReport(HID_CT_INIT_REQ, 0x80001, 0, 0);
		debug('connect result:', r);
		if (r.cmd != HID_CT_INIT_ACK) {
			throw new Error(`Init failed, got message ${r.cmd}, expected ${HID_CT_INIT_ACK}`);
		}
	}

	pollDevice()
	{
		const r = this.device.getFeatureReport(HID_REPORT_CT, HID_REPORT_CT_LEN);
		const buf = Buffer.from(r);
		const msg = {
			cmd: buf.readUInt8(1),
			len: buf.readUInt32LE(2),
			id: buf.readUInt8(6),
			drop: buf.readUInt8(7),
		};
		if (msg.drop === 1) {
			// Device wants to reply first
			debug('Device wants to transmit first?');
			this.handleControl(msg)
			return this.pollDevice();
			// TODO: Resent prev event
		}
		if (msg.cmd != 0) this.handleControl(msg);
	}

	handleControl(msg)
	{
		// Map incoming messages to pending commands
		debug(`Incoming control message 0x${msg.cmd.toString(16)} with ID: 0x${msg.id.toString(16)}`);
		let handled = false;
		this.pendingMessages = this.pendingMessages.filter(pendingMsg => {
			if (
				(pendingMsg.id === msg.id)
				|| ((pendingMsg.cmd == 1) && (msg.cmd == 2))
			) {
				handled = true;
				pendingMsg.handler(msg);
				return false; // remove pending message
			}
			return true; // keep message for later
		});
		if (handled) return;

		// Unsolicited message
		switch (msg.cmd) {
			case HID_CT_ALLOC_REQ:
				this.sendReportNoWait(HID_CT_ALLOC_ACK, msg.length, msg.id);
				break;
			case HID_CT_DEALLOC_REQ:
				this.sendReportNoWait(HID_CT_DEALLOC_ACK, msg.length, msg.id);
				break;
			default:
				debug(`Received unknown unsolicited message from device: 0x${msg.cmd.toString(16)}`);
				break;
		}
	}

	handleInterrupt(data)
	{
		const usbHeader = {
			report: data.readUInt8(0),
			id: data.readUInt8(1),
			segment: data.readUInt16LE(2),
			// Reports are always 0x64 bytes in length, but only this many bytes
			// contain data.  The rest is just leftover data in a buffer from previous
			// calls.
			lenValid: data.readUInt16LE(4),
		};
		debug('usbHeader:', usbHeader);

		const hiQnetMsg = data.slice(6, 6 + usbHeader.lenValid);

		if (usbHeader.segment === 0) {
			// First message in a segment
			let msgIncoming = {
				id: usbHeader.id,
				lastSegment: usbHeader.segment,
				lenExpected: hiQnetMsg.readUInt32BE(2),
				payload: hiQnetMsg,
			};

			if (msgIncoming.lenExpected === msgIncoming.payload.length) {
				// Received full message
				debug(`Received single-segment HiQnet message`);
				if (this.callback) this.callback(msgIncoming.payload);
			} else {
				// Partial message, save for later
				debug(`Received segment 0 of HiQnet message #${msgIncoming.id.toString(16)}`);
				this.incomingMessages.push(msgIncoming);
			}

		} else {
			// Subsequent message in a segment
			let msgIncoming = this.incomingMessages.find(m => m.id == usbHeader.id);
			if (!msgIncoming) {
				debug(`Ignoring segment ${usbHeader.segment} of message #${usbHeader.id.toString(16)} as we aren't tracking that message!`);
				return;
			}
			msgIncoming.payload = Buffer.concat([
				msgIncoming.payload,
				hiQnetMsg,
			]);
			if (msgIncoming.lenExpected === msgIncoming.payload.length) {
				// Received full message
				debug(`Received final segment ${usbHeader.segment} of HiQnet message #${msgIncoming.id.toString(16)}`);
				if (this.callback) this.callback(msgIncoming.payload);
			} else {
				debug(`Received segment ${usbHeader.segment} of HiQnet message `
					+ `#${msgIncoming.id.toString(16)} (got ${msgIncoming.payload.length}`
					+ ` bytes, waiting for ${msgIncoming.lenExpected} bytes)`);
			}
		}
	}

	sendReportNoWait(cmd, len, id, flag = 1)
	{
		let hidReport = Buffer.alloc(HID_REPORT_CT_LEN);
		hidReport.writeUInt8(HID_REPORT_CT, 0);
		hidReport.writeUInt8(cmd, 1);
		hidReport.writeUInt32LE(len, 2);
		hidReport.writeUInt8(flag, 6);
		hidReport.writeUInt8(id, 7);
		debug(`Sending control 0x${cmd.toString(16)} with id 0x${id.toString(16)}`);
		this.device.sendFeatureReport(Array.from(hidReport));
	}

	sendReport(cmd, len, id, flag = 1)
	{
		return new Promise((resolve, reject) => {
			if (id === undefined) id = this.idNext++;
			this.pendingMessages.push({
				cmd: cmd,
				id: id,
				handler: msg => {
					debug('Resolving message', id);
					if (msg.drop === 0) {
						resolve(msg);
					} else {
						reject(new DeviceBusyError(msg));
					}
				},
			});

			this.sendReportNoWait(cmd, len, id, flag);
		});
	}

	async sendMessage(payload) {
		const id = this.idNext++;

		try {
			let ack = await this.sendReport(HID_CT_ALLOC_REQ, payload.length, id);
			if (ack.cmd != HID_CT_ALLOC_ACK) {
				debug('Unexpected response to alloc:', ack);
				return;
			}
		} catch (e) {
			if (e instanceof DeviceBusyError) {
				return await this.sendMessage(payload);
			}
			throw e;
		}

		let remaining = payload;
		let chunkNum = 0;
		do {
			const chunk = remaining.slice(0, HID_REPORT_TX_LEN);
			remaining = remaining.slice(HID_REPORT_TX_LEN);

			let hidReportHeader = Buffer.alloc(6);
			hidReportHeader.writeUInt8(HID_REPORT_TX, 0);
			hidReportHeader.writeUInt8(id, 1);
			hidReportHeader.writeUInt16LE(chunkNum, 2);
			hidReportHeader.writeUInt16LE(chunk.length, 4);
			const hidReport = Buffer.concat([
				hidReportHeader,
				chunk,
				Buffer.alloc(HID_REPORT_TX_LEN - hidReportHeader.length - chunk.length), // padding
			]);
			debug('writing interrupt chunk:', hidReport);
			this.device.write(Array.from(hidReport));

			chunkNum++;
		} while (remaining.length > 0);

		let ack = await this.sendReport(HID_CT_DEALLOC_REQ, payload.length);//, id);
		if (ack.cmd != HID_CT_DEALLOC_ACK) {
			debug('Unexpected response to dealloc:', ack);
			return;
		}
	}
};

module.exports = HiQnetTransportUSB;
