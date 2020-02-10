/**
 * HiQnet device control library.
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

class DeviceBusyError extends Error { };

class DeviceError extends Error
{
	constructor(msgHiQnet)
	{
		super(msgHiQnet.header.error.codeName + ' "' + msgHiQnet.header.error.text + '"');

		this.msgHiQnet = msgHiQnet;
		this.deviceText = msgHiQnet.header.error.text;
		this.code = msgHiQnet.header.error.code;
		this.codeName = msgHiQnet.header.error.codeName;
	}
};

module.exports = { DeviceBusyError, DeviceError };
